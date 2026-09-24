import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'buffer'
import { PublicKey, SystemProgram, type AccountInfo, type Connection } from '@solana/web3.js'
import { DEVNET, MAINNET, type NetworkConfig } from '../../src/networks.js'
import { DEFAULT_FEE_POLICY } from '../../src/fees.js'
import { MerkleTree, type LeafRecord, type OwnedNote, type PoseidonHasher } from '../../src/protocol/index.js'
import { PoolSynchronizer, PoolSyncError, poolStorageNamespace, validateNullifierAccount } from '../../src/pool.js'
import { MemoryPoolStorage, type PoolStorage, type PublicPoolCache } from '../../src/storage.js'
import type { ApiPoolState, HttpApi } from '../../src/transport.js'
import { FIELD_SIZE } from '../../src/protocol/validation.js'

const hasher: PoseidonHasher = inputs => inputs.reduce((sum, value, index) => (sum + value * BigInt(index + 2)) % FIELD_SIZE, 1n)
const be32 = (value: string) => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex')
const accountInfo = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 })

function fixture(count = 2, config: NetworkConfig = DEVNET) {
  const program = new PublicKey(config.programId)
  const bump = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[1]
  const leaves: LeafRecord[] = Array.from({ length: count }, (_, index) => ({ index, commitment: String(index + 10), encryptedOutput: '' }))
  const root = new MerkleTree(hasher, leaves.map(leaf => leaf.commitment)).root()
  const treeData = Buffer.alloc(4136)
  Buffer.from([147, 200, 34, 248, 131, 187, 248, 253]).copy(treeData)
  treeData.fill(7, 8, 40)
  treeData.writeBigUInt64LE(BigInt(count), 40)
  be32(root).copy(treeData, 880); be32(root).copy(treeData, 912)
  treeData.writeBigUInt64LE(1_000_000_000_000n, 4120)
  treeData[4128] = 26; treeData[4129] = 100; treeData[4130] = bump('merkle_tree')
  const globalData = Buffer.alloc(48)
  Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]).copy(globalData)
  globalData.fill(7, 8, 40); globalData.writeUInt16LE(20, 42); globalData[46] = bump('global_config')
  const accounts: (AccountInfo<Buffer> | null)[] = [accountInfo(treeData, program), accountInfo(globalData, program), null]
  const advertised: ApiPoolState = { programId: config.programId, relayer: config.relayer,
    network: config.network, genesisHash: config.genesisHash, root, leafCount: count, chainLeaves: count, indexedLeaves: count,
    feePolicy: DEFAULT_FEE_POLICY, shutdownAt: null, relayerEnabled: true, faucetEnabled: false, rpcUrl: 'https://ignored.invalid' }
  const reads: string[][] = []
  const pages: number[] = []
  let genesis = config.genesisHash
  let noteError = false
  let markers: (AccountInfo<Buffer> | null)[] = []
  let markerOffset = 0
  let leafResponse: ((from: number, limit: number) => { leaves: LeafRecord[]; total: number }) | undefined
  let scanned = 0
  let owned: OwnedNote[] = []
  const connection: Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfo'> = {
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async keys => {
      reads.push(keys.map(key => key.toBase58()))
      const treePda = PublicKey.findProgramAddressSync([Buffer.from('merkle_tree')], program)[0]
      if (keys[0]?.equals(treePda)) { markerOffset = 0; return accounts }
      if (noteError) throw new Error('private-rpc-url')
      const values = keys.map((_, index) => markers[markerOffset + index] ?? null)
      markerOffset += keys.length
      return values
    },
  }
  const api: Pick<HttpApi, 'state' | 'leaves'> = {
    state: async () => advertised,
    leaves: async (from, limit = 2000) => { pages.push(from); return leafResponse ? leafResponse(from, limit) : { leaves: leaves.slice(from, from + limit), total: count } },
  }
  const scanner = { scan: (input: readonly LeafRecord[]) => { scanned++; assert.deepEqual(input, leaves); return owned } }
  return { config, program, root, leaves, accounts, treeData, globalData, advertised, reads, pages, connection, api, scanner,
    setGenesis: (value: string) => { genesis = value }, setNoteError: () => { noteError = true },
    setOwned: (value: OwnedNote[]) => { owned = value }, setMarkers: (value: (AccountInfo<Buffer> | null)[]) => { markers = value },
    setLeafResponse: (value: typeof leafResponse) => { leafResponse = value }, scanned: () => scanned,
    sync: (storage?: PoolStorage, overrides: { maxPages?: number; maxLeaves?: number } = {}) => new PoolSynchronizer({ config, connection, api, hasher, ...(storage ? { storage } : {}), ...overrides }),
  }
}

test('validates empty roots and never sends an empty nullifier RPC request', async () => {
  const f = fixture(0)
  const result = await f.sync().sync(f.scanner)
  assert.equal(result.balanceLamports, 0n)
  assert.equal(result.state.root, f.root)
  assert.deepEqual(result.state.recentRoots, [f.root])
  assert.deepEqual(f.reads.map(read => read.length), [3])
  assert.equal(f.pages.length, 0)
})

test('both networks require genesis, owner, discriminator, fee layout and valid root history', async () => {
  for (const config of [DEVNET, MAINNET]) {
    const f = fixture(2, config)
    f.setGenesis('wrong-genesis')
    await assert.rejects(f.sync().sync(f.scanner), /different Solana network/)
    assert.equal(f.reads.length, 0)
    for (const mutate of [
      (v: ReturnType<typeof fixture>) => { v.accounts[0] = null },
      (v: ReturnType<typeof fixture>) => { v.accounts[0]!.owner = SystemProgram.programId },
      (v: ReturnType<typeof fixture>) => { v.treeData[0] = v.treeData[0]! ^ 1 },
      (v: ReturnType<typeof fixture>) => { v.treeData[4130] = v.treeData[4130]! ^ 1 },
      (v: ReturnType<typeof fixture>) => { v.treeData.writeBigUInt64LE(3n, 40) },
      (v: ReturnType<typeof fixture>) => { v.globalData.writeUInt16LE(1, 40) },
      (v: ReturnType<typeof fixture>) => { v.globalData[8] = v.globalData[8]! ^ 1 },
      (v: ReturnType<typeof fixture>) => { be32(FIELD_SIZE.toString()).copy(v.treeData, 944) },
    ]) {
      const invalid = fixture(2, config); mutate(invalid)
      await assert.rejects(invalid.sync().sync(invalid.scanner), PoolSyncError)
      assert.equal(invalid.scanned(), 0)
    }
  }
})

test('chain fee mismatch and indexer lag stop before decrypting or spending', async () => {
  for (const patch of [{ indexedLeaves: 0 }, { indexedLeaves: 4 }, { root: '2' }, { feePolicy: { ...DEFAULT_FEE_POLICY, basisPoints: 35 } }]) {
    const f = fixture(); Object.assign(f.advertised, patch)
    await assert.rejects(f.sync().sync(f.scanner), PoolSyncError)
    assert.equal(f.scanned(), 0)
  }
})

test('pagination rejects gaps, over-target, stalled pages and configured resource overflow', async () => {
  for (const response of [
    { leaves: [], total: 2 }, { leaves: [{ index: 1, commitment: '11', encryptedOutput: '' }], total: 2 },
    { leaves: [{ index: 0, commitment: '10', encryptedOutput: '' }], total: 4 },
    { leaves: Array.from({ length: 3 }, (_, index) => ({ index, commitment: '10', encryptedOutput: '' })), total: 2 },
  ]) {
    const f = fixture(); f.setLeafResponse(() => response)
    await assert.rejects(f.sync().sync(f.scanner), PoolSyncError)
    assert.equal(f.pages.length, 1)
    assert.equal(f.scanned(), 0)
  }
  const f = fixture(4)
  f.setLeafResponse(from => ({ leaves: f.leaves.slice(from, from + 1), total: 4 }))
  await assert.rejects(f.sync(undefined, { maxPages: 1 }).sync(f.scanner), /page limit/)
  assert.equal(f.pages.length, 1)
  await assert.rejects(f.sync(undefined, { maxLeaves: 2 }).sync(f.scanner), /leaf limit/)
})

test('a poisoned cached root is discarded and rebuilt once from a fresh contiguous prefix', async () => {
  const f = fixture()
  const storage = new MemoryPoolStorage()
  const namespace = poolStorageNamespace(f.config)
  await storage.save(namespace, { version: 1, namespace, leaves: f.leaves.map(leaf => ({ ...leaf, commitment: '999' })) })
  const result = await f.sync(storage).sync(f.scanner)
  assert.equal(result.tree.root(), f.root)
  assert.deepEqual(f.pages, [0])
  assert.deepEqual((await storage.load(namespace))?.leaves, f.leaves)
})

test('an invalid fresh root never reaches scanning or storage save', async () => {
  const f = fixture()
  f.setLeafResponse(() => ({ total: 2, leaves: f.leaves.map(leaf => ({ ...leaf, commitment: '999' })) }))
  let saves = 0
  const storage: PoolStorage = { load: async () => null, remove: async () => {}, save: async () => { saves++ } }
  await assert.rejects(f.sync(storage).sync(f.scanner), /on-chain Merkle root/)
  assert.equal(f.pages.length, 1)
  assert.equal(saves, 0)
  assert.equal(f.scanned(), 0)
})

test('cache namespaces isolate network, pool and genesis; only public whitelisted data is saved', async () => {
  const f = fixture()
  const writes: PublicPoolCache[] = []
  const storage: PoolStorage = {
    load: async () => ({ version: 1, namespace: poolStorageNamespace(MAINNET), leaves: f.leaves }),
    remove: async () => {}, save: async (_namespace, value) => { writes.push(value) },
  }
  await f.sync(storage).sync(f.scanner)
  assert.deepEqual(f.pages, [0])
  assert.equal(writes[0]?.namespace, poolStorageNamespace(DEVNET))
  assert.deepEqual(Object.keys(writes[0]!).sort(), ['leaves', 'namespace', 'version'])
  assert.deepEqual(Object.keys(writes[0]!.leaves[0]!).sort(), ['commitment', 'encryptedOutput', 'index'])
  assert.notEqual(poolStorageNamespace(DEVNET), poolStorageNamespace(MAINNET))
  assert.notEqual(poolStorageNamespace(DEVNET), poolStorageNamespace({ ...DEVNET, apiUrl: 'https://another-indexer.example/api' }))
  assert.equal(poolStorageNamespace(DEVNET), poolStorageNamespace({ ...DEVNET, rpcUrl: 'https://rpc.example/?private-key=not-a-real-key' }))
})

test('nullifier checks use 100-account chunks and derive total versus two-input spendable balance', async () => {
  const f = fixture(102)
  const owned: OwnedNote[] = f.leaves.map(leaf => ({ ...leaf, amount: BigInt(leaf.index + 1), nullifier: String(leaf.index + 1000) }))
  f.setOwned(owned)
  const spent = Buffer.from([250, 31, 238, 177, 213, 98, 48, 172, 0])
  f.setMarkers([accountInfo(spent, f.program)])
  const result = await f.sync().sync(f.scanner)
  assert.deepEqual(f.reads.map(read => read.length), [3, 100, 2])
  assert.equal(result.notes.length, 101)
  assert.equal(result.balanceLamports, 102n * 103n / 2n - 1n)
  assert.equal(result.spendableLamports, 203n)
  assert.deepEqual(f.pages, [0])
})

test('nullifier RPC failure never returns indexer fallback or a spendable balance', async () => {
  const f = fixture(); f.setOwned([{ amount: 1n, index: 0, commitment: '10', nullifier: '123' }]); f.setNoteError()
  await assert.rejects(f.sync().sync(f.scanner), (error: unknown) => error instanceof PoolSyncError && !error.message.includes('private-rpc'))
})

test('nullifier validator treats prefunded empty system PDAs as unspent and malformed owners as errors', () => {
  const program = new PublicKey(DEVNET.programId)
  assert.equal(validateNullifierAccount(null, program), false)
  assert.equal(validateNullifierAccount(accountInfo(Buffer.alloc(0), SystemProgram.programId), program), false)
  assert.equal(validateNullifierAccount(accountInfo(Buffer.from([250, 31, 238, 177, 213, 98, 48, 172, 0]), program), program), true)
  assert.throws(() => validateNullifierAccount(accountInfo(Buffer.alloc(9), program), program), PoolSyncError)
  assert.throws(() => validateNullifierAccount(accountInfo(Buffer.from([250, 31, 238, 177, 213, 98, 48, 172, 0]), SystemProgram.programId), program), PoolSyncError)
})

test('shutdown validates its owner and zero deposit limit; empty system notice is not a shutdown', async () => {
  const f = fixture()
  f.accounts[2] = accountInfo(Buffer.alloc(0), SystemProgram.programId)
  assert.equal((await f.sync().sync(f.scanner)).state.shutdownAt, null)
  const notice = Buffer.alloc(24)
  Buffer.from([77, 14, 100, 61, 159, 192, 169, 28]).copy(notice)
  notice.writeBigInt64LE(2_000_000_000n, 8)
  notice[16] = PublicKey.findProgramAddressSync([Buffer.from('shutdown')], f.program)[1]
  f.accounts[2] = accountInfo(notice, f.program)
  await assert.rejects(f.sync().sync(f.scanner), /deposit limit/)
  f.treeData.writeBigUInt64LE(0n, 4120)
  assert.equal((await f.sync().sync(f.scanner)).state.shutdownAt, 2_000_000_000)
})

test('cancellation interrupts pending RPC and no cache or balance is exposed', async () => {
  const f = fixture()
  f.connection.getGenesisHash = async () => new Promise<string>(() => {})
  const controller = new AbortController()
  const promise = f.sync().sync(f.scanner, { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(f.scanned(), 0)
})

test('an injected RPC that ignores cancellation still has a bounded per-operation timeout', async () => {
  const f = fixture()
  f.connection.getGenesisHash = async () => new Promise<string>(() => {})
  const sync = new PoolSynchronizer({ config: f.config, api: f.api, connection: f.connection, hasher, rpcTimeoutMs: 2 })
  await assert.rejects(sync.sync(f.scanner), /timed out/)
  assert.equal(f.scanned(), 0)
})

test('mutation of returned leaves cannot poison the synchronizer internal cache', async () => {
  const f = fixture()
  const sync = f.sync()
  const first = await sync.sync(f.scanner)
  first.leaves[0]!.commitment = '999'
  first.tree.append('20')
  const second = await sync.sync(f.scanner)
  assert.equal(second.tree.root(), f.root)
  assert.equal(second.leaves[0]!.commitment, '10')
  assert.deepEqual(f.pages, [0])
})
