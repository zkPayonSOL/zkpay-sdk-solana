import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha256'
import { assertNetworkConfig, type NetworkConfig } from './networks.js'
import { MAX_TRANSACTION_LAMPORTS } from './amounts.js'
import { validateFeePolicy, type FeePolicy } from './fees.js'
import { validateSerializedProof, type SerializedProof } from './protocol/proof.js'
import { FIELD_SIZE, fromBytes } from './protocol/validation.js'
import type { LeafRecord } from './protocol/index.js'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_LEAVES = 2 ** 26
export interface RequestOptions { signal?: AbortSignal }
export interface ApiPoolState {
  readonly programId: string
  readonly relayer: string
  readonly network?: 'devnet' | 'mainnet-beta'
  readonly genesisHash?: string
  readonly root: string
  readonly leafCount: number
  readonly chainLeaves: number
  readonly indexedLeaves: number
  readonly shutdownAt: number | null
  readonly relayerEnabled: boolean
  readonly faucetEnabled: boolean
  readonly feePolicy: FeePolicy
  /** Informational only. Never used to replace the caller's RPC connection. */
  readonly rpcUrl: string
}
export interface RelayRequest {
  proof: SerializedProof
  extAmount: string
  fee: string
  encryptedOutput1: string
  encryptedOutput2: string
  recipient: string
}
export interface RelayResult { readonly signature: string; readonly confirmed: boolean }

/** Contains sanitized metadata only; never response bodies or upstream URLs. */
export class HttpApiError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HttpApiError'
    this.status = status
  }
}
/** A failed relay HTTP exchange does not establish that the payment was not submitted. */
export class RelaySubmissionUnknownError extends HttpApiError {
  constructor(status?: number) {
    super('Relay submission status is unknown. Check the saved payment intent and on-chain status before retrying.', status)
    this.name = 'RelaySubmissionUnknownError'
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpApiError('Invalid API response shape.')
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpApiError('Invalid API integer.')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpApiError('Invalid API boolean.')
  return value
}
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new HttpApiError('Invalid API public key.')
  try { if (new PublicKey(value).toBase58() === value) return value } catch { /* sanitized below */ }
  throw new HttpApiError('Invalid API public key.')
}
export function validateSignature(value: unknown): string {
  if (typeof value === 'string' && value.length >= 64 && value.length <= 88) {
    try { if (bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value) return value } catch { /* sanitized below */ }
  }
  throw new HttpApiError('Invalid transaction signature.')
}
function decimalField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 77 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= FIELD_SIZE) {
    throw new HttpApiError('Invalid API field element.')
  }
  return value
}
/** Chain events may contain arbitrary opaque note bytes, including notes we cannot decrypt. */
export function validateLeafRecord(value: unknown, expectedIndex: number): LeafRecord {
  const item = record(value)
  if (integer(item.index, 0, MAX_LEAVES - 1) !== expectedIndex) throw new HttpApiError('The leaf page is not contiguous.')
  const commitment = decimalField(item.commitment)
  if (typeof item.encryptedOutput !== 'string' || item.encryptedOutput.length > 2464 || !/^(?:[0-9a-fA-F]{2})*$/.test(item.encryptedOutput)) {
    throw new HttpApiError('Invalid encrypted note encoding.')
  }
  return Object.freeze({ index: expectedIndex, commitment, encryptedOutput: item.encryptedOutput.toLowerCase() })
}
function abort(signal?: AbortSignal): void { signal?.throwIfAborted() }
async function boundedWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let stop: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([pending, cancelled]) }
  finally { if (stop) signal.removeEventListener('abort', stop) }
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  abort(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** HTTPS except explicit localhost development; credentials and redirect following are forbidden. */
export function validateApiUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpApiError('Invalid API endpoint.') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) throw new HttpApiError('API endpoints must use HTTPS (HTTP is allowed only on localhost).')
  return url.href.replace(/\/+$/, '')
}

export class HttpApi {
  readonly config: NetworkConfig
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #maxBytes: number
  readonly #base: string
  constructor(config: NetworkConfig, options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; maxResponseBytes?: number } = {}) {
    assertNetworkConfig(config)
    this.#base = validateApiUrl(config.apiUrl)
    address(config.programId); address(config.relayer)
    this.config = Object.freeze({ ...config })
    this.#fetch = options.fetch ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') throw new HttpApiError('A fetch implementation is required.')
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1, 120_000)
    this.#maxBytes = integer(options.maxResponseBytes ?? MAX_BYTES, 1, MAX_BYTES)
  }

  async #once(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    abort(signal)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), this.#timeoutMs)
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body)
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > MAX_BYTES) throw new HttpApiError('API request exceeds the size limit.')
      const response = await boundedWait(this.#fetch(`${this.#base}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }),
      }), controller.signal)
      if (response.redirected || response.status >= 300 && response.status < 400) throw new HttpApiError('API redirects are forbidden.', response.status)
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HttpApiError('The API request failed.', response.status) }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') throw new HttpApiError('The API response is not JSON.')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.#maxBytes)) throw new HttpApiError('API response exceeds the size limit.')
      if (!response.body) throw new HttpApiError('Empty API response.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let count = 0
      try {
        for (;;) {
          controller.signal.throwIfAborted()
          const part = await boundedWait(reader.read(), controller.signal)
          if (part.done) break
          count += part.value.length
          if (count > this.#maxBytes) throw new HttpApiError('API response exceeds the size limit.')
          chunks.push(part.value)
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
      catch { throw new HttpApiError('Invalid JSON API response.') }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (error instanceof HttpApiError) throw error
      throw new HttpApiError('API connection failed or timed out.')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  async #get(path: string, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#once(path, undefined, signal) }
      catch (error) {
        abort(signal)
        if (!(error instanceof HttpApiError) || attempt >= 2 ||
            (error.status !== undefined && error.status !== 429 && error.status < 500) ||
            (error.status === undefined && error.message !== 'API connection failed or timed out.')) throw error
        await delay(100 * (attempt + 1), signal)
      }
    }
  }
  async state(options: RequestOptions = {}): Promise<ApiPoolState> {
    const value = record(await this.#get('state', options.signal))
    const programId = address(value.programId), relayer = address(value.relayer)
    if (programId !== this.config.programId || relayer !== this.config.relayer) throw new HttpApiError('The API returned a different pool identity.')
    if (this.config.network === 'mainnet-beta' &&
        (value.network !== this.config.network || value.genesisHash !== this.config.genesisHash || value.faucetEnabled !== false)) {
      throw new HttpApiError('The API did not verify the configured Mainnet identity.')
    }
    if (value.network !== undefined && value.network !== this.config.network || value.genesisHash !== undefined && value.genesisHash !== this.config.genesisHash) {
      throw new HttpApiError('The API returned a different network.')
    }
    const feePolicy: FeePolicy = {
      model: value.feeModel as FeePolicy['model'], basisPoints: integer(value.withdrawFeeBps, 0, 100),
      baseLamports: BigInt(integer(value.baseFeeLamports, 0, Number.MAX_SAFE_INTEGER)),
    }
    try { validateFeePolicy(feePolicy) } catch { throw new HttpApiError('The API returned an unsupported withdrawal fee policy.') }
    const leafCount = integer(value.leafCount, 0, MAX_LEAVES)
    const chainLeaves = integer(value.chainLeaves ?? leafCount, 0, MAX_LEAVES)
    const indexedLeaves = integer(value.indexedLeaves ?? leafCount, 0, MAX_LEAVES)
    if (leafCount !== indexedLeaves || chainLeaves % 2 !== 0) throw new HttpApiError('Inconsistent API leaf counts.')
    if (typeof value.rpcUrl !== 'string' || value.rpcUrl.length > 2048) throw new HttpApiError('Invalid informational RPC endpoint.')
    const shutdownAt = value.shutdownAt === null || value.shutdownAt === undefined ? null : integer(value.shutdownAt, 1, Number.MAX_SAFE_INTEGER)
    return Object.freeze({ programId, relayer, root: decimalField(value.root), leafCount, chainLeaves, indexedLeaves, shutdownAt,
      relayerEnabled: boolean(value.relayerEnabled), faucetEnabled: boolean(value.faucetEnabled), feePolicy: Object.freeze(feePolicy), rpcUrl: value.rpcUrl,
      ...(value.network === undefined ? {} : { network: this.config.network }),
      ...(value.genesisHash === undefined ? {} : { genesisHash: this.config.genesisHash }),
    })
  }
  async leaves(from: number, limit = 2000, options: RequestOptions = {}): Promise<{ leaves: LeafRecord[]; total: number }> {
    integer(from, 0, MAX_LEAVES); integer(limit, 1, 5000)
    const value = record(await this.#get(`leaves?from=${from}&limit=${limit}`, options.signal))
    const total = integer(value.total, from, MAX_LEAVES)
    if (!Array.isArray(value.leaves) || value.leaves.length > limit || from + value.leaves.length > total) throw new HttpApiError('Invalid API leaf page size.')
    return { leaves: value.leaves.map((leaf, index) => validateLeafRecord(leaf, from + index)), total }
  }
  async nullifiers(after: number, options: RequestOptions = {}): Promise<{ pdas: string[]; next: number }> {
    integer(after, 0, Number.MAX_SAFE_INTEGER)
    const value = record(await this.#get(`nullifiers?after=${after}`, options.signal))
    const next = integer(value.next, after, Number.MAX_SAFE_INTEGER)
    if (!Array.isArray(value.pdas) || value.pdas.length > 5000 || (value.pdas.length === 0 ? next !== after : next <= after)) throw new HttpApiError('Invalid nullifier page cursor.')
    const pdas = value.pdas.map(address)
    if (new Set(pdas).size !== pdas.length) throw new HttpApiError('Duplicate nullifier markers.')
    return { pdas, next }
  }
  async ingest(signature: string, options: RequestOptions = {}): Promise<{ contiguous: number }> {
    validateSignature(signature)
    const value = record(await this.#once('ingest', { signature }, options.signal))
    return { contiguous: integer(value.contiguous, 0, MAX_LEAVES) }
  }
  async relay(body: RelayRequest, options: RequestOptions = {}): Promise<RelayResult> {
    const safeBody = validateRelayRequest(body, this.config)
    abort(options.signal)
    try {
      const value = record(await this.#once('relay', safeBody, options.signal))
      return Object.freeze({ signature: validateSignature(value.signature), confirmed: boolean(value.confirmed) })
    } catch (error) { throw new RelaySubmissionUnknownError(error instanceof HttpApiError ? error.status : undefined) }
  }
}

function validateRelayRequest(body: RelayRequest, config: NetworkConfig): RelayRequest {
  if (!body || typeof body !== 'object') throw new TypeError('A public relay request is required.')
  validateSerializedProof(body.proof)
  if (typeof body.extAmount !== 'string' || !/^-[1-9][0-9]{0,18}$/.test(body.extAmount) ||
      typeof body.fee !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(body.fee)) throw new TypeError('Relay amounts must be canonical integer strings.')
  const net = -BigInt(body.extAmount), fee = BigInt(body.fee), gross = net + fee
  if (net > MAX_TRANSACTION_LAMPORTS || fee > MAX_TRANSACTION_LAMPORTS || gross > MAX_TRANSACTION_LAMPORTS) throw new RangeError('Relay withdrawal is out of range.')
  for (const note of [body.encryptedOutput1, body.encryptedOutput2]) {
    if (typeof note !== 'string' || !/^[0-9a-fA-F]{150}$/.test(note)) throw new TypeError('Relay notes must be 75 hex-encoded bytes.')
  }
  const recipient = address(body.recipient)
  const program = new PublicKey(config.programId)
  const forbidden = [program, ...['merkle_tree', 'tree_token', 'global_config'].map(seed => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0])]
  if (forbidden.some(key => key.toBase58() === recipient)) throw new TypeError('The recipient cannot be a pool account.')
  if (fromBytes(Uint8Array.from(body.proof.publicAmount)) !== FIELD_SIZE - gross) throw new TypeError('The relay proof does not bind its withdrawal amount.')
  const signedAmount = Buffer.alloc(8); signedAmount.writeBigInt64LE(-net)
  const feeBytes = Buffer.alloc(8); feeBytes.writeBigUInt64LE(fee)
  const noteLength = Buffer.alloc(4); noteLength.writeUInt32LE(75)
  const mint = Buffer.alloc(32); mint[31] = 1
  const digest = sha256(Buffer.concat([new PublicKey(recipient).toBuffer(), signedAmount,
    noteLength, Buffer.from(body.encryptedOutput1, 'hex'), noteLength, Buffer.from(body.encryptedOutput2, 'hex'),
    feeBytes, new PublicKey(config.relayer).toBuffer(), mint]))
  if (fromBytes(digest, true) % FIELD_SIZE !== fromBytes(Uint8Array.from(body.proof.extDataHash))) throw new TypeError('The relay proof does not bind this recipient, relayer and notes.')
  // Whitelist fields. Never serialize accidental private witness/key properties from caller objects.
  return { proof: { proofA: [...body.proof.proofA], proofB: [...body.proof.proofB], proofC: [...body.proof.proofC],
    root: [...body.proof.root], publicAmount: [...body.proof.publicAmount], extDataHash: [...body.proof.extDataHash],
    inputNullifiers: body.proof.inputNullifiers.map(value => [...value]), outputCommitments: body.proof.outputCommitments.map(value => [...value]) },
    extAmount: body.extAmount, fee: body.fee, recipient, encryptedOutput1: body.encryptedOutput1, encryptedOutput2: body.encryptedOutput2 }
}
