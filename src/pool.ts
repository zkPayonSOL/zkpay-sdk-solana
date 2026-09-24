import { Buffer } from 'buffer'
import { PublicKey, SystemProgram, type AccountInfo, type Connection } from '@solana/web3.js'
import { assertNetworkConfig, type NetworkConfig } from './networks.js'
import { WITHDRAWAL_FEE_MODEL, validateFeePolicy, type FeePolicy } from './fees.js'
import { HttpApi, validateLeafRecord, type ApiPoolState, type RequestOptions } from './transport.js'
import type { PoolStorage, PublicPoolCache } from './storage.js'
import { MerkleTree } from './protocol/merkle-tree.js'
import { getProgramAccounts, nullifierPdaFor } from './protocol/transaction.js'
import { FIELD_SIZE, type PoseidonHasher } from './protocol/validation.js'
import type { LeafRecord, OwnedNote, ProtocolAccount } from './protocol/index.js'

const TREE_DISC = Buffer.from([147, 200, 34, 248, 131, 187, 248, 253])
const GLOBAL_DISC = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217])
const SHUTDOWN_DISC = Buffer.from([77, 14, 100, 61, 159, 192, 169, 28])
const NULLIFIER_DISC = Buffer.from([250, 31, 238, 177, 213, 98, 48, 172])
const CAPACITY = 2 ** 26
type RpcConnection = Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfo'>
type PoolApi = Pick<HttpApi, 'state' | 'leaves'>
type Scanner = Pick<ProtocolAccount, 'scan'>

export class PoolSyncError extends Error {
  constructor(message = 'The pool could not be verified. Synchronize again before spending.') { super(message); this.name = 'PoolSyncError' }
}
export interface ValidatedPoolState {
  readonly network: NetworkConfig['network']
  readonly programId: string
  readonly relayer: string
  readonly genesisHash: string
  readonly root: string
  readonly recentRoots: readonly string[]
  readonly leafCount: number
  readonly maxDepositLamports: bigint
  readonly shutdownAt: number | null
  readonly feePolicy: FeePolicy
  readonly relayerEnabled: boolean
}
export interface PoolSnapshot {
  readonly tree: MerkleTree
  readonly leaves: readonly LeafRecord[]
  readonly notes: readonly OwnedNote[]
  readonly balanceLamports: bigint
  /** Maximum gross debit available to the circuit's two input slots. */
  readonly spendableLamports: bigint
  readonly state: ValidatedPoolState
}
export interface PoolSynchronizerOptions {
  config: NetworkConfig
  api: PoolApi
  connection: RpcConnection
  hasher: PoseidonHasher
  storage?: PoolStorage
  /** Local resource cap, not a protocol tree-size change. Default 1,000,000 leaves. */
  maxLeaves?: number
  /** Bounded HTTP work per synchronization. Default 500 pages of at most 2,000. */
  maxPages?: number
  /** Deadline for each RPC/cache operation, including injected connections. Default 30 seconds. */
  rpcTimeoutMs?: number
}

export function poolStorageNamespace(config: NetworkConfig): string {
  return `zkpay.solana.pool.v1:${config.network}:${config.genesisHash}:${config.programId}`
}
function checkedInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`Invalid ${name}.`)
  return value
}
function abort(signal?: AbortSignal): void { signal?.throwIfAborted() }
async function interruptible<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  abort(signal)
  if (!signal && timeoutMs === undefined) return promise
  let onAbort: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new PoolSyncError('The RPC or cache operation timed out.')), timeoutMs)
  })
  try { return await Promise.race([promise, interrupted]) }
  finally { if (onAbort) signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer) }
}
function publicCopy(leaves: readonly LeafRecord[]): LeafRecord[] {
  return leaves.map(leaf => ({ index: leaf.index, commitment: leaf.commitment, encryptedOutput: leaf.encryptedOutput }))
}
function isAccount(account: AccountInfo<Buffer> | null | undefined, program: PublicKey, disc: Buffer, lengths: readonly number[]): account is AccountInfo<Buffer> {
  return !!account && !account.executable && account.owner.equals(program) && lengths.includes(account.data.length) && account.data.subarray(0, 8).equals(disc)
}
function scalar(bytes: Buffer): bigint { return BigInt(`0x${bytes.toString('hex')}`) }

/** Returns spent/unspent, throwing on malformed accounts. The caller must query the derived PDA. */
export function validateNullifierAccount(account: AccountInfo<Buffer> | null, programId: PublicKey): boolean {
  if (account === null || !account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0) return false
  // Deployed transact does not write NullifierAccount.bump; it stays zero.
  // Its owner/discriminator and existence, not that reserved byte, mark a spend.
  if (!isAccount(account, programId, NULLIFIER_DISC, [9])) throw new PoolSyncError('A nullifier account has an invalid owner or layout.')
  return true
}

/** Verified independently of indexer state; offsets include Anchor's discriminator. */
function readChainState(config: NetworkConfig, accounts: (AccountInfo<Buffer> | null)[]): Omit<ValidatedPoolState, 'relayerEnabled'> {
  if (accounts.length !== 3) throw new PoolSyncError('The RPC returned an incomplete pool account snapshot.')
  const [tree, global, notice] = accounts
  const program = new PublicKey(config.programId)
  const bump = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[1]
  if (!isAccount(tree, program, TREE_DISC, [4136]) || tree.data[4128] !== 26 || tree.data[4129] !== 100 || tree.data[4130] !== bump('merkle_tree')) {
    throw new PoolSyncError('The on-chain pool account is absent or has an invalid owner, layout or PDA bump.')
  }
  const leafCount = tree.data.readBigUInt64LE(40)
  const rootIndex = tree.data.readBigUInt64LE(4112)
  const root = scalar(tree.data.subarray(880, 912))
  const recentRoots: string[] = []
  for (let index = 0; index < 100; index++) {
    const value = scalar(tree.data.subarray(912 + index * 32, 944 + index * 32))
    if (value >= FIELD_SIZE) throw new PoolSyncError('The on-chain root history contains an invalid field element.')
    if (value > 0n) recentRoots.push(value.toString())
  }
  if (leafCount > BigInt(CAPACITY) || leafCount % 2n !== 0n || rootIndex >= 100n || root === 0n || root >= FIELD_SIZE ||
      !tree.data.subarray(912 + Number(rootIndex) * 32, 944 + Number(rootIndex) * 32).equals(tree.data.subarray(880, 912))) {
    throw new PoolSyncError('The on-chain pool Merkle state is invalid.')
  }
  if (!isAccount(global, program, GLOBAL_DISC, [47, 48]) || global.data[46] !== bump('global_config') ||
      !tree.data.subarray(8, 40).equals(global.data.subarray(8, 40)) || global.data.readUInt16LE(40) !== 0 || global.data.readUInt16LE(44) !== 0) {
    throw new PoolSyncError('The on-chain fee account is absent or invalid.')
  }
  const feePolicy: FeePolicy = Object.freeze({ model: WITHDRAWAL_FEE_MODEL, basisPoints: global.data.readUInt16LE(42), baseLamports: 6_000_000n })
  try { validateFeePolicy(feePolicy) } catch { throw new PoolSyncError('The on-chain withdrawal policy is unsupported.') }
  let shutdownAt: number | null = null
  const emptyNotice = notice && !notice.executable && notice.owner.equals(SystemProgram.programId) && notice.data.length === 0
  if (notice && !emptyNotice) {
    if (!isAccount(notice, program, SHUTDOWN_DISC, [17, 24]) || notice.data[16] !== bump('shutdown')) throw new PoolSyncError('The shutdown account is invalid.')
    const timestamp = notice.data.readBigInt64LE(8)
    if (timestamp <= 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new PoolSyncError('The shutdown timestamp is invalid.')
    shutdownAt = Number(timestamp)
  }
  const maxDepositLamports = tree.data.readBigUInt64LE(4120)
  if (shutdownAt !== null && maxDepositLamports !== 0n) throw new PoolSyncError('The shutdown and deposit limit disagree.')
  return Object.freeze({ network: config.network, programId: config.programId, relayer: config.relayer, genesisHash: config.genesisHash,
    root: root.toString(), recentRoots: Object.freeze(recentRoots), leafCount: Number(leafCount), maxDepositLamports, shutdownAt, feePolicy })
}

/**
 * Downloads public pool leaves and decrypts locally. It never sends an owned-note
 * list to the indexer. Spent checks do send owned nullifier PDA addresses to the
 * caller-selected RPC, which can correlate those requests; choose that provider
 * according to your privacy requirements. RPC failure is never a spendable balance.
 */
export class PoolSynchronizer {
  readonly #config: NetworkConfig
  readonly #api: PoolApi
  readonly #connection: RpcConnection
  readonly #hasher: PoseidonHasher
  readonly #storage: PoolStorage | undefined
  readonly #maxLeaves: number
  readonly #maxPages: number
  readonly #namespace: string
  readonly #rpcTimeoutMs: number
  #leaves: readonly LeafRecord[] = []
  #loaded = false
  #queue: Promise<void> = Promise.resolve()
  constructor(options: PoolSynchronizerOptions) {
    assertNetworkConfig(options.config)
    this.#config = Object.freeze({ ...options.config })
    this.#api = options.api
    this.#connection = options.connection
    this.#hasher = options.hasher
    this.#storage = options.storage
    this.#maxLeaves = checkedInteger(options.maxLeaves ?? 1_000_000, CAPACITY, 'maximum cached leaves')
    this.#maxPages = checkedInteger(options.maxPages ?? 500, CAPACITY, 'maximum synchronization pages')
    this.#rpcTimeoutMs = checkedInteger(options.rpcTimeoutMs ?? 30_000, 120_000, 'RPC timeout')
    this.#namespace = poolStorageNamespace(this.#config)
  }

  sync(account: Scanner, options: RequestOptions = {}): Promise<PoolSnapshot> {
    const task = this.#queue.then(() => this.#sync(account, options))
    this.#queue = task.then(() => {}, () => {})
    return interruptible(task, options.signal)
  }

  async #load(signal?: AbortSignal): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (!this.#storage) return
    let candidate: PublicPoolCache | null | undefined
    try { candidate = await interruptible(this.#storage.load(this.#namespace), signal, this.#rpcTimeoutMs) }
    catch { abort(signal); return }
    if (!candidate) return
    try {
      if (candidate.version !== 1 || candidate.namespace !== this.#namespace || !Array.isArray(candidate.leaves) || candidate.leaves.length > this.#maxLeaves) throw new Error()
      this.#leaves = candidate.leaves.map((leaf, index) => validateLeafRecord(leaf, index))
    } catch { await this.#discard(signal) }
  }
  async #discard(signal?: AbortSignal): Promise<void> {
    this.#leaves = []
    try { await interruptible(this.#storage?.remove(this.#namespace) ?? Promise.resolve(), signal, this.#rpcTimeoutMs) }
    catch { abort(signal) /* A cache failure does not prevent a verified refetch. */ }
  }
  async #sync(account: Scanner, options: RequestOptions): Promise<PoolSnapshot> {
    const signal = options.signal
    abort(signal)
    try {
      const genesis = await interruptible(this.#connection.getGenesisHash(), signal, this.#rpcTimeoutMs)
      if (genesis !== this.#config.genesisHash) throw new PoolSyncError('The RPC belongs to a different Solana network.')
      const program = new PublicKey(this.#config.programId)
      const { treeAccount, globalConfig } = getProgramAccounts(program)
      const shutdown = PublicKey.findProgramAddressSync([Buffer.from('shutdown')], program)[0]
      const [accounts, advertised] = await Promise.all([
        interruptible(this.#connection.getMultipleAccountsInfo([treeAccount, globalConfig, shutdown], 'confirmed'), signal, this.#rpcTimeoutMs),
        this.#api.state(options),
      ])
      abort(signal)
      const chain = readChainState(this.#config, accounts)
      this.#checkAdvertisement(chain, advertised)
      if (chain.leafCount > this.#maxLeaves) throw new PoolSyncError('The pool exceeds this synchronizer\'s configured leaf limit.')
      await this.#load(signal)
      if (this.#leaves.length > chain.leafCount) await this.#discard(signal)
      let tree: MerkleTree | undefined
      let leaves: LeafRecord[] = []
      let pages = 0
      for (let rebuild = 0; rebuild < 2; rebuild++) {
        leaves = publicCopy(this.#leaves)
        tree = new MerkleTree(this.#hasher, leaves.map(leaf => leaf.commitment))
        const usedCache = leaves.length > 0
        while (leaves.length < chain.leafCount) {
          abort(signal)
          if (++pages > this.#maxPages) throw new PoolSyncError('The synchronization page limit was reached.')
          const limit = Math.min(2000, chain.leafCount - leaves.length)
          const page = await this.#api.leaves(leaves.length, limit, options)
          if (!page || !Array.isArray(page.leaves) || !Number.isSafeInteger(page.total) || page.total !== chain.leafCount ||
              page.leaves.length === 0 || page.leaves.length > limit) throw new PoolSyncError('The indexer is behind, ahead, or returned a stalled leaf page. Synchronize again.')
          for (const raw of page.leaves) {
            const leaf = validateLeafRecord(raw, leaves.length)
            leaves.push(leaf)
            tree.append(leaf.commitment)
          }
        }
        if (tree.root() === chain.root) break
        await this.#discard(signal)
        if (!usedCache || rebuild === 1) throw new PoolSyncError('The indexed leaves do not match the on-chain Merkle root.')
        tree = undefined
      }
      if (!tree || tree.root() !== chain.root) throw new PoolSyncError()
      abort(signal)
      const owned = account.scan(publicCopy(leaves))
      const notes: OwnedNote[] = []
      for (let offset = 0; offset < owned.length; offset += 100) {
        const batch = owned.slice(offset, offset + 100)
        const markers = await interruptible(this.#connection.getMultipleAccountsInfo(batch.map(note => nullifierPdaFor(program, note.nullifier)), 'confirmed'), signal, this.#rpcTimeoutMs)
        if (markers.length !== batch.length) throw new PoolSyncError('The RPC returned an incomplete spent-note snapshot.')
        for (let index = 0; index < batch.length; index++) {
          const marker = markers[index]
          if (marker === undefined) throw new PoolSyncError('The RPC returned an incomplete spent-note snapshot.')
          if (!validateNullifierAccount(marker, program)) notes.push(batch[index]!)
        }
      }
      abort(signal)
      const snapshot: PublicPoolCache = { version: 1, namespace: this.#namespace, leaves: publicCopy(leaves) }
      try { await interruptible(this.#storage?.save(this.#namespace, snapshot) ?? Promise.resolve(), signal, this.#rpcTimeoutMs) }
      catch { abort(signal) /* Cache persistence is optional; the validated result remains usable. */ }
      this.#leaves = publicCopy(leaves)
      const sorted = [...notes].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)
      return Object.freeze({ tree, leaves: Object.freeze(publicCopy(leaves)), notes: Object.freeze(notes),
        balanceLamports: notes.reduce((sum, note) => sum + note.amount, 0n),
        spendableLamports: sorted.slice(0, 2).reduce((sum, note) => sum + note.amount, 0n),
        state: Object.freeze({ ...chain, relayerEnabled: advertised.relayerEnabled }) })
    } catch (error) {
      abort(signal)
      if (error instanceof PoolSyncError) throw error
      throw new PoolSyncError('The pool or spent-note status could not be verified. No spendable balance was returned.')
    }
  }
  #checkAdvertisement(chain: Omit<ValidatedPoolState, 'relayerEnabled'>, state: ApiPoolState): void {
    if (state.programId !== this.#config.programId || state.relayer !== this.#config.relayer ||
        state.feePolicy.model !== chain.feePolicy.model || state.feePolicy.basisPoints !== chain.feePolicy.basisPoints || state.feePolicy.baseLamports !== chain.feePolicy.baseLamports) {
      throw new PoolSyncError('The indexer and on-chain pool identity or fee policy disagree.')
    }
    if (state.indexedLeaves !== chain.leafCount) throw new PoolSyncError('The indexer has not reached the on-chain snapshot, or the pool changed. Synchronize again.')
    if (state.chainLeaves === chain.leafCount && state.root !== chain.root) throw new PoolSyncError('The indexer and RPC disagree about the pool root.')
  }
}
