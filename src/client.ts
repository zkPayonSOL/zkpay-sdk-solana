import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { assertLamports } from './amounts.js'
import { quoteWithdrawal, type FeePolicy, type WithdrawalQuote } from './fees.js'
import { getNetworkConfig, validateEndpoint, verifyRpcNetwork, type Network, type NetworkConfig } from './networks.js'
import {
  ProtocolAccount, buildTransactIx, getProgramAccounts, nullifierPdaFor,
  type BuiltTransaction, type PoseidonHasher, type ProofProvider,
} from './protocol/index.js'
import { createDefaultHasher, createProver } from './proving/index.js'
import { PoolSynchronizer, validateNullifierAccount, type PoolSnapshot } from './pool.js'
import { HttpApi } from './transport.js'
import type { PublicPoolStorage } from './storage.js'
import { deriveSpendingSecret, resolveSigningHost, signExactTransaction, type WalletSigner } from './wallet.js'

export interface CallOptions { signal?: AbortSignal }
export interface ClientBaseOptions {
  network: Network
  wallet: WalletSigner
  apiUrl?: string
  fetch?: typeof globalThis.fetch
  storage?: PublicPoolStorage
  /** Trusted local implementation: a prover receives the private witness. */
  prover?: ProofProvider
  hasher?: PoseidonHasher
  signingHost?: string
  timeoutMs?: number
}

/** Supply exactly one caller-owned Mainnet RPC transport; there is no fallback. */
export type ClientOptions = ClientBaseOptions & (
  | { rpcUrl: string; connection?: never }
  | { connection: Connection; rpcUrl?: never }
)

function assertRpcSelection(options: ClientOptions): void {
  const hasUrl = options.rpcUrl !== undefined
  const hasConnection = options.connection !== undefined
  if (hasUrl === hasConnection) throw new TypeError('Provide exactly one Mainnet rpcUrl or Connection. The SDK has no default RPC.')
  if (hasUrl) {
    if (typeof options.rpcUrl !== 'string' || options.rpcUrl.trim().length === 0) throw new TypeError('A nonempty Mainnet rpcUrl is required.')
    validateEndpoint(options.rpcUrl, 'rpc')
  } else if (!options.connection || typeof options.connection.getGenesisHash !== 'function') {
    throw new TypeError('Provide a configured Solana Connection for Mainnet.')
  }
}

export interface PrivateBalance {
  readonly network: Network
  readonly programId: string
  readonly balanceLamports: bigint
  readonly spendableLamports: bigint
  readonly noteCount: number
  readonly leafCount: number
  readonly root: string
  readonly maxDepositLamports: bigint
  readonly shutdownAt: number | null
  readonly feePolicy: FeePolicy
  readonly verified: true
}

/**
 * No spending secret, signature, private witness or plaintext note is included.
 * This metadata still links a payment to its public commitments: store privately.
 */
export interface PaymentIntent {
  /** Account-bound authentication of all tracking fields; preserve when persisting. */
  readonly authentication: string
  readonly id: string
  readonly kind: 'deposit' | 'withdrawal'
  readonly network: Network
  readonly programId: string
  readonly root: string
  readonly grossLamports: string
  readonly feeLamports: string
  readonly recipient: string
  readonly inputNullifiers: readonly string[]
  readonly outputCommitments: readonly string[]
}
type PaymentIntentBody = Omit<PaymentIntent, 'authentication'>

export interface PendingPayment {
  readonly status: 'submitted' | 'unknown'
  readonly intent: PaymentIntent
  readonly signature?: string
}
export type PaymentStatus = PendingPayment | {
  readonly status: 'confirmed'
  readonly intent: PaymentIntent
  readonly signature?: string
  readonly verifiedBy: 'pool-effects'
} | {
  readonly status: 'failed'
  readonly intent: PaymentIntent
  readonly signature: string
}

export interface PreparedDeposit {
  readonly transaction: VersionedTransaction
  readonly intent: PaymentIntent
  readonly lastValidBlockHeight: number
}
export interface PreparedWithdrawal {
  readonly intent: PaymentIntent
  readonly quote: WithdrawalQuote
}

export class SubmissionUnknownError extends Error {
  constructor(readonly payment: PendingPayment) {
    super('Submission outcome is unknown. Keep this payment intent and check its status before preparing another payment. Do not blindly retry.')
    this.name = 'SubmissionUnknownError'
  }
}

interface PreparedRecord {
  built: BuiltTransaction
  intent: PaymentIntent
  used: boolean
  message?: Uint8Array
  feePolicy: FeePolicy
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
function decimal(bytes: readonly number[]): string {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString()
}
function signature(value: string): string {
  try {
    if (typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64) return value
  } catch { /* Use the same non-sensitive error for all malformed responses. */ }
  throw new Error('Invalid transaction signature.')
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Explicitly unlocked, per-wallet client. Importing this module performs no I/O. */
export class ZkPayClient {
  readonly config: NetworkConfig
  #wallet: WalletSigner
  #walletAddress: string
  #signingHost: string
  #connection: Connection
  #api: HttpApi
  #pool: PoolSynchronizer
  #hasher: PoseidonHasher
  #prover: ProofProvider
  #account: ProtocolAccount | undefined
  #trackingKey: Uint8Array | undefined
  #busy = false
  #disposed = false
  #lifetime = new AbortController()
  #prepared = new WeakMap<object, PreparedRecord>()
  #pending: PendingPayment | undefined
  #localDepositSignatures = new Map<string, PaymentIntent>()
  #timeoutMs: number

  private constructor(options: ClientOptions, hasher: PoseidonHasher) {
    this.config = getNetworkConfig(options.network, {
      ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
      ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    })
    this.#wallet = options.wallet
    this.#timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) throw new RangeError('Invalid request timeout.')
    this.#walletAddress = options.wallet.publicKey.toBase58()
    this.#signingHost = resolveSigningHost(options.signingHost)
    this.#hasher = hasher
    this.#prover = options.prover ?? createProver({
      ...(options.fetch ? { fetch: options.fetch } : {}), signal: this.#lifetime.signal,
    })
    const fetcher = options.fetch ?? globalThis.fetch
    this.#connection = options.connection ?? new Connection(this.config.rpcUrl!, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: (input, init) => fetcher(input, { ...init, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.#timeoutMs), ...(init?.signal ? [init.signal] : [])]),
      }),
    })
    this.#api = new HttpApi(this.config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
    this.#pool = new PoolSynchronizer({
      config: this.config, api: this.#api, connection: this.#connection, hasher,
      rpcTimeoutMs: this.#timeoutMs,
      ...(options.storage ? { storage: options.storage } : {}),
    })
  }

  static async create(options: ClientOptions): Promise<ZkPayClient> {
    getNetworkConfig(options.network)
    if (!options.wallet?.publicKey || typeof options.wallet.signMessage !== 'function' || typeof options.wallet.signTransaction !== 'function') {
      throw new TypeError('A wallet with message signing and v0 transaction signing is required.')
    }
    assertRpcSelection(options)
    const hasher = options.hasher ?? await createDefaultHasher()
    return new ZkPayClient(options, hasher)
  }

  get isUnlocked(): boolean { return !!this.#account && !this.#disposed }
  get pendingPayment(): PendingPayment | undefined { return this.#pending }

  #assertActive(): void {
    if (this.#disposed) throw new Error('This zkPay client has been disposed.')
    if (this.#wallet.publicKey.toBase58() !== this.#walletAddress) throw new Error('Wallet account changed. Create a new client for the selected account.')
  }
  #unlocked(): ProtocolAccount {
    this.#assertActive()
    if (!this.#account) throw new Error('Call unlock() before accessing the private balance.')
    return this.#account
  }
  #noPending(): void {
    if (this.#pending) throw new Error('A previous payment is still pending or unknown. Check its status before preparing another payment.')
  }
  async #operation<T>(options: CallOptions, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertActive()
    if (this.#busy) throw new Error('Another operation is in progress for this client.')
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal
    signal.throwIfAborted()
    this.#busy = true
    try { return await task(signal) } finally { this.#busy = false }
  }
  async #network(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.#assertActive()
    await this.#rpc(() => verifyRpcNetwork(this.#connection, this.config), signal)
    signal.throwIfAborted()
    this.#assertActive()
  }
  async #rpc<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)])
    let onAbort: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('RPC operation interrupted or timed out.'))
      deadline.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([task(), stopped])
      signal.throwIfAborted()
      this.#assertActive()
      return result
    } catch {
      signal.throwIfAborted()
      throw new Error('The selected network RPC request failed or timed out.')
    } finally { if (onAbort) deadline.removeEventListener('abort', onAbort) }
  }
  async #sync(signal: AbortSignal): Promise<PoolSnapshot> {
    await this.#network(signal)
    const pool = await this.#pool.sync(this.#unlocked(), { signal })
    signal.throwIfAborted()
    this.#assertActive()
    return pool
  }

  /** Requests the deterministic unlock signature once; never stores it. */
  unlock(options: CallOptions = {}): Promise<void> {
    return this.#operation(options, async signal => {
      if (this.#account) return
      await this.#network(signal)
      const secret = await deriveSpendingSecret(this.#wallet, this.config, this.#signingHost)
      try {
        signal.throwIfAborted()
        this.#assertActive()
        this.#trackingKey = sha256(concatBytes(utf8ToBytes('zkpay/sdk/payment-intent-key/v1'), secret))
        if (this.#pending) this.#verifyIntent(this.#pending.intent)
        this.#account = new ProtocolAccount(secret, this.#hasher)
      } catch (error) {
        this.#trackingKey?.fill(0)
        this.#trackingKey = undefined
        throw error
      } finally { secret.fill(0) }
    })
  }

  getPrivateBalance(options: CallOptions = {}): Promise<PrivateBalance> {
    return this.#operation(options, async signal => {
      const pool = await this.#sync(signal)
      return Object.freeze({
        network: this.config.network, programId: this.config.programId,
        balanceLamports: pool.balanceLamports, spendableLamports: pool.spendableLamports,
        noteCount: pool.notes.length, leafCount: pool.state.leafCount, root: pool.state.root,
        maxDepositLamports: pool.state.maxDepositLamports, shutdownAt: pool.state.shutdownAt,
        feePolicy: Object.freeze({ ...pool.state.feePolicy }), verified: true as const,
      })
    })
  }

  #intent(kind: PaymentIntent['kind'], built: BuiltTransaction, gross: bigint): PaymentIntent {
    const idBytes = new Uint8Array(16)
    if (!globalThis.crypto?.getRandomValues) throw new Error('A native cryptographic random generator is required.')
    globalThis.crypto.getRandomValues(idBytes)
    const body: PaymentIntentBody = {
      id: Buffer.from(idBytes).toString('hex'), kind,
      network: this.config.network, programId: this.config.programId,
      root: decimal(built.proof.root), grossLamports: gross.toString(), feeLamports: built.fee.toString(),
      recipient: built.recipient.toBase58(),
      inputNullifiers: Object.freeze(built.proof.inputNullifiers.map(decimal)),
      outputCommitments: Object.freeze([...built.outputCommitments]),
    }
    return Object.freeze({ ...body, authentication: this.#intentAuthentication(body) })
  }

  #intentBody(i: PaymentIntentBody): PaymentIntentBody {
    return { id: i.id, kind: i.kind, network: i.network, programId: i.programId,
      root: i.root, grossLamports: i.grossLamports, feeLamports: i.feeLamports, recipient: i.recipient,
      inputNullifiers: [...i.inputNullifiers], outputCommitments: [...i.outputCommitments] }
  }
  #intentAuthentication(intent: PaymentIntentBody): string {
    if (!this.#trackingKey) throw new Error('Unlock the account before authenticating payment metadata.')
    return Buffer.from(hmac(sha256, this.#trackingKey, utf8ToBytes(JSON.stringify(this.#intentBody(intent))))).toString('hex')
  }
  #verifyIntent(intent: PaymentIntent): void {
    const expected = this.#intentAuthentication(intent)
    let mismatch = expected.length ^ intent.authentication.length
    for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ intent.authentication.charCodeAt(index)
    if (mismatch !== 0) throw new Error('Payment intent authentication failed. Restore the original record for this wallet, network, and signing host.')
  }

  async #prepareDeposit(amountLamports: bigint, microLamports: number, signal: AbortSignal): Promise<PreparedDeposit> {
    this.#noPending()
    assertLamports(amountLamports)
    if (!Number.isSafeInteger(microLamports) || microLamports < 0 || microLamports > 200_000) throw new RangeError('Priority fee must be 0–200000 micro-lamports per compute unit.')
    const pool = await this.#sync(signal)
    if (pool.state.shutdownAt !== null || amountLamports > pool.state.maxDepositLamports) throw new Error('Deposits are disabled or this amount exceeds the current pool limit.')
    const built = await this.#unlocked().buildDeposit({
      tree: pool.tree, amount: amountLamports, notes: pool.notes,
      feeRecipient: new PublicKey(this.config.relayer), prover: this.#prover,
    })
    signal.throwIfAborted()
    this.#assertActive()
    const latest = await this.#rpc(() => this.#connection.getLatestBlockhash('finalized'), signal)
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: new PublicKey(this.#walletAddress), recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        buildTransactIx({
          programId: new PublicKey(this.config.programId), ...built,
          feeRecipient: new PublicKey(this.config.relayer), signer: new PublicKey(this.#walletAddress),
        }),
      ],
    }).compileToV0Message())
    if (transaction.serialize().length > 1232) throw new Error('Deposit transaction exceeds the Solana packet limit.')
    const intent = this.#intent('deposit', built, amountLamports)
    const prepared = Object.freeze({ transaction, intent, lastValidBlockHeight: latest.lastValidBlockHeight })
    this.#prepared.set(prepared, { built, intent, used: false, message: transaction.message.serialize().slice(), feePolicy: pool.state.feePolicy })
    return prepared
  }

  prepareDeposit(input: { lamports: bigint; priorityFeeMicroLamports?: number }, options: CallOptions = {}): Promise<PreparedDeposit> {
    return this.#operation(options, signal => this.#prepareDeposit(input.lamports, input.priorityFeeMicroLamports ?? 1_000, signal))
  }

  async #checkPrepared(prepared: object, kind: PaymentIntent['kind'], signal: AbortSignal): Promise<PreparedRecord> {
    this.#noPending()
    const record = this.#prepared.get(prepared)
    if (!record || record.used || record.intent.kind !== kind) throw new Error('Prepared payment is invalid, already submitted, or belongs to another client.')
    const pool = await this.#sync(signal)
    if (!pool.state.recentRoots.includes(record.intent.root)) throw new Error('Prepared proof root has expired. Prepare a fresh payment before signing or submitting.')
    if (kind === 'deposit') {
      if (pool.state.shutdownAt !== null || BigInt(record.intent.grossLamports) > pool.state.maxDepositLamports) throw new Error('Deposit policy changed. Prepare the payment again.')
    } else {
      const current = quoteWithdrawal(BigInt(record.intent.grossLamports), pool.state.feePolicy)
      if (current.feeLamports !== record.built.fee) throw new Error('Withdrawal fee policy changed. Review a fresh quote before sending.')
    }
    const nullifiers = record.intent.inputNullifiers.map(value => nullifierPdaFor(new PublicKey(this.config.programId), value))
    const accounts = await this.#rpc(() => this.#connection.getMultipleAccountsInfo(nullifiers, 'confirmed'), signal)
    if (accounts.length !== 2 || accounts.some(account => validateNullifierAccount(account, new PublicKey(this.config.programId)))) throw new Error('A prepared payment input is already spent. Refresh the private balance.')
    signal.throwIfAborted()
    return record
  }

  async #submitDeposit(prepared: PreparedDeposit, signal: AbortSignal): Promise<PendingPayment> {
    const record = await this.#checkPrepared(prepared, 'deposit', signal)
    if (!record.message || !equalBytes(prepared.transaction.message.serialize(), record.message)) throw new Error('Prepared deposit transaction was modified.')
    const signed = await signExactTransaction(this.#wallet, prepared.transaction)
    await this.#network(signal)
    const localSignature = signature(bs58.encode(signed.signatures[0]!))
    record.used = true
    const pending: PendingPayment = Object.freeze({ status: 'unknown', intent: record.intent, signature: localSignature })
    this.#pending = pending
    this.#localDepositSignatures.set(localSignature, record.intent)
    try {
      const submitted = await this.#rpc(() => this.#connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0,
      }), signal)
      if (signature(submitted) !== localSignature) throw new Error('RPC returned an unexpected signature.')
      const result: PendingPayment = Object.freeze({ ...pending, status: 'submitted' })
      this.#pending = result
      // Indexing is best effort; it cannot turn a sent transaction into a failed payment.
      void this.#api.ingest(localSignature, { signal }).catch(() => undefined)
      return result
    } catch { throw new SubmissionUnknownError(pending) }
  }

  submitDeposit(prepared: PreparedDeposit, options: CallOptions = {}): Promise<PendingPayment> {
    return this.#operation(options, signal => this.#submitDeposit(prepared, signal))
  }

  deposit(input: { lamports: bigint; priorityFeeMicroLamports?: number }, options: CallOptions = {}): Promise<PendingPayment> {
    return this.#operation(options, async signal => this.#submitDeposit(
      await this.#prepareDeposit(input.lamports, input.priorityFeeMicroLamports ?? 1_000, signal), signal,
    ))
  }

  async #prepareWithdrawal(input: { lamports: bigint; recipient: PublicKey | string }, signal: AbortSignal): Promise<PreparedWithdrawal> {
    this.#noPending()
    assertLamports(input.lamports)
    const recipient = new PublicKey(input.recipient)
    const program = new PublicKey(this.config.programId)
    const accounts = getProgramAccounts(program)
    if ([program, accounts.treeAccount, accounts.treeTokenAccount, accounts.globalConfig].some(key => key.equals(recipient))) throw new Error('Recipient cannot be a zkPay program or pool account.')
    const pool = await this.#sync(signal)
    const quote = quoteWithdrawal(input.lamports, pool.state.feePolicy)
    const built = await this.#unlocked().buildWithdrawal({
      tree: pool.tree, gross: input.lamports, fee: quote.feeLamports, notes: pool.notes,
      recipient, feeRecipient: new PublicKey(this.config.relayer), prover: this.#prover,
    })
    signal.throwIfAborted()
    this.#assertActive()
    const intent = this.#intent('withdrawal', built, input.lamports)
    const prepared = Object.freeze({ intent, quote })
    this.#prepared.set(prepared, { built, intent, used: false, feePolicy: pool.state.feePolicy })
    return prepared
  }

  prepareWithdrawal(input: { lamports: bigint; recipient: PublicKey | string }, options: CallOptions = {}): Promise<PreparedWithdrawal> {
    return this.#operation(options, signal => this.#prepareWithdrawal(input, signal))
  }

  async #submitWithdrawal(prepared: PreparedWithdrawal, signal: AbortSignal): Promise<PendingPayment> {
    const record = await this.#checkPrepared(prepared, 'withdrawal', signal)
    const state = await this.#api.state({ signal })
    if (state.relayerEnabled === false) throw new Error('The relayer is currently disabled.')
    const quote = quoteWithdrawal(BigInt(record.intent.grossLamports), state.feePolicy)
    if (quote.feeLamports !== record.built.fee) throw new Error('Withdrawal fee policy changed. Review a fresh quote before sending.')
    await this.#network(signal)
    signal.throwIfAborted()
    this.#assertActive()
    record.used = true
    const pending: PendingPayment = Object.freeze({ status: 'unknown', intent: record.intent })
    this.#pending = pending
    try {
      const built = record.built
      const result = await this.#api.relay({
        proof: built.proof, extAmount: built.extAmount.toString(), fee: built.fee.toString(),
        encryptedOutput1: Buffer.from(built.encryptedOutput1).toString('hex'),
        encryptedOutput2: Buffer.from(built.encryptedOutput2).toString('hex'),
        recipient: built.recipient.toBase58(),
      }, { signal })
      // The relayer's confirmed flag is only a hint; we independently verify effects.
      const submitted: PendingPayment = Object.freeze({ status: 'submitted', intent: record.intent, signature: signature(result.signature) })
      this.#pending = submitted
      return submitted
    } catch { throw new SubmissionUnknownError(pending) }
  }

  submitWithdrawal(prepared: PreparedWithdrawal, options: CallOptions = {}): Promise<PendingPayment> {
    return this.#operation(options, signal => this.#submitWithdrawal(prepared, signal))
  }

  /** Relayed withdrawal: lamports is the gross debit, including the fee. */
  send(input: { lamports: bigint; recipient: PublicKey | string }, options: CallOptions = {}): Promise<PendingPayment> {
    return this.#operation(options, async signal => this.#submitWithdrawal(await this.#prepareWithdrawal(input, signal), signal))
  }

  #assertPayment(payment: PendingPayment): void {
    const i = payment?.intent
    if (!i || typeof i.authentication !== 'string' || !/^[a-f0-9]{64}$/.test(i.authentication) ||
        !['submitted', 'unknown'].includes(payment.status) || i.network !== this.config.network || i.programId !== this.config.programId ||
        typeof i.id !== 'string' || !/^[a-f0-9]{32}$/.test(i.id) || !['deposit', 'withdrawal'].includes(i.kind) ||
        !Array.isArray(i.inputNullifiers) || i.inputNullifiers.length !== 2 ||
        !Array.isArray(i.outputCommitments) || i.outputCommitments.length !== 2) throw new TypeError('Invalid payment intent for this network and pool.')
    if (typeof i.grossLamports !== 'string' || !/^[1-9]\d{0,18}$/.test(i.grossLamports) ||
        typeof i.feeLamports !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(i.feeLamports)) throw new TypeError('Invalid payment amount.')
    const gross = BigInt(i.grossLamports)
    const fee = BigInt(i.feeLamports)
    assertLamports(gross)
    if (i.kind === 'deposit' ? fee !== 0n || i.recipient !== this.config.relayer : fee < 6_000_000n || fee >= gross || fee > gross / 100n + 6_000_000n) throw new TypeError('Invalid payment fee or recipient.')
    if (typeof i.recipient !== 'string' || i.recipient.length < 32 || i.recipient.length > 44) throw new TypeError('Invalid payment recipient.')
    new PublicKey(i.recipient)
    for (const value of [i.root, ...i.inputNullifiers, ...i.outputCommitments]) {
      if (typeof value !== 'string' || !/^(0|[1-9]\d{0,76})$/.test(value)) throw new TypeError('Invalid payment intent field.')
      nullifierPdaFor(new PublicKey(this.config.programId), value)
    }
    if (i.inputNullifiers[0] === i.inputNullifiers[1] || i.outputCommitments[0] === i.outputCommitments[1]) throw new TypeError('Payment fields must be distinct.')
    if (payment.signature !== undefined) signature(payment.signature)
    if (this.#pending?.intent.id === i.id && (!this.#sameIntent(this.#pending.intent, i) ||
        payment.signature !== undefined && payment.signature !== this.#pending.signature)) throw new TypeError('Payment metadata does not match the tracked payment.')
    if (this.#trackingKey) this.#verifyIntent(i)
  }

  #copyIntent(i: PaymentIntent): PaymentIntent {
    return Object.freeze({ ...this.#intentBody(i), authentication: i.authentication,
      inputNullifiers: Object.freeze([...i.inputNullifiers]), outputCommitments: Object.freeze([...i.outputCommitments]),
    })
  }
  #sameIntent(a: PaymentIntent, b: PaymentIntent): boolean {
    return JSON.stringify(this.#copyIntent(a)) === JSON.stringify(this.#copyIntent(b))
  }
  #copyPayment(payment: PendingPayment): PendingPayment {
    this.#assertPayment(payment)
    const retainedSignature = payment.signature ?? (this.#pending?.intent.id === payment.intent.id ? this.#pending.signature : undefined)
    return Object.freeze({ status: payment.status, intent: this.#copyIntent(payment.intent),
      ...(retainedSignature ? { signature: retainedSignature } : {}),
    })
  }

  /** Restore public tracking metadata after a restart. This never broadcasts. */
  resumePayment(payment: PendingPayment): void {
    this.#assertActive()
    if (this.#busy) throw new Error('Another operation is in progress for this client.')
    this.#assertPayment(payment)
    if (this.#pending && this.#pending.intent.id !== payment.intent.id) throw new Error('Another unresolved payment is already being tracked.')
    this.#pending = this.#copyPayment(payment)
  }

  async #paymentStatus(payment: PendingPayment, signal: AbortSignal): Promise<PaymentStatus> {
    this.#assertPayment(payment)
    this.#unlocked()
    this.#verifyIntent(payment.intent)
    const pool = await this.#sync(signal)
    const outputs = payment.intent.outputCommitments
    const first = pool.tree.indexOf(outputs[0]!)
    const effectsIndexed = first >= 0 && first % 2 === 0 && pool.leaves[first + 1]?.commitment === outputs[1]
    if (effectsIndexed) {
      const program = new PublicKey(this.config.programId)
      const keys = payment.intent.inputNullifiers.map(value => nullifierPdaFor(program, value))
      const spent = await this.#rpc(() => this.#connection.getMultipleAccountsInfo(keys, 'confirmed'), signal)
      const valid = spent.length === 2 && spent.every(account => validateNullifierAccount(account, program))
      if (!valid) throw new Error('Indexed payment outputs do not match verified spent inputs.')
      if (this.#pending?.intent.id === payment.intent.id) this.#pending = undefined
      return Object.freeze({ ...payment, status: 'confirmed', verifiedBy: 'pool-effects' })
    }
    if (payment.signature) {
      const statuses = await this.#rpc(() => this.#connection.getSignatureStatuses([payment.signature!], { searchTransactionHistory: true }), signal)
      const status = statuses.value[0]
      const localIntent = this.#localDepositSignatures.get(payment.signature)
      if (payment.intent.kind === 'deposit' && localIntent && this.#sameIntent(localIntent, payment.intent) && status?.err && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
        if (this.#pending?.intent.id === payment.intent.id) this.#pending = undefined
        return Object.freeze({ status: 'failed', signature: payment.signature, intent: payment.intent })
      }
    }
    return payment
  }

  async getPaymentStatus(payment: PendingPayment, options: CallOptions = {}): Promise<PaymentStatus> {
    const snapshot = this.#copyPayment(payment)
    return this.#operation(options, signal => this.#paymentStatus(snapshot, signal))
  }

  /** Bounded polling. A timeout returns the pending payment, not a failure. */
  waitForConfirmation(payment: PendingPayment, options: CallOptions & { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<PaymentStatus> {
    const timeout = options.timeoutMs ?? 90_000
    const interval = options.pollIntervalMs ?? 2_000
    const snapshot = this.#copyPayment(payment)
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 600_000 || !Number.isSafeInteger(interval) || interval < 100 || interval > 30_000) throw new RangeError('Invalid confirmation polling limits.')
    return this.#operation(options, async signal => {
      const deadline = Date.now() + timeout
      const polling = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      do {
        signal.throwIfAborted()
        try {
          const status = await this.#paymentStatus(snapshot, polling)
          if (status.status === 'confirmed' || status.status === 'failed') return status
        } catch {
          // A status/indexer failure cannot authorize another payment or mean failed.
          signal.throwIfAborted()
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || polling.aborted) return snapshot
        await sleep(Math.min(interval, remaining), signal)
      } while (Date.now() <= deadline)
      return snapshot
    })
  }

  /** Best-effort key cleanup; JavaScript cannot guarantee wiping all VM copies. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#lifetime.abort(new Error('Client disposed.'))
    this.#account?.dispose()
    this.#account = undefined
    this.#trackingKey?.fill(0)
    this.#trackingKey = undefined
    this.#prepared = new WeakMap()
  }
}
