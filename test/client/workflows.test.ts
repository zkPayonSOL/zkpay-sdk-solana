/**
 * Offline high-level workflows. The wallet uses a public, unfunded fixed seed.
 * Notes use real NaCl encryption; the injected hasher/prover are deterministic
 * fixtures, not a pairing-verification or live-chain claim. No network is used.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo, type Connection } from '@solana/web3.js'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { sha256 } from '@noble/hashes/sha256'
import { ZkPayClient, SubmissionUnknownError, type PendingPayment } from '../../src/client.js'
import { DEVNET } from '../../src/networks.js'
import { createUnlockMessage, type WalletSigner } from '../../src/wallet.js'
import {
  ProtocolAccount, MerkleTree, getProgramAccounts, nullifierPdaFor,
  type BuiltTransaction, type CircuitInput, type LeafRecord, type PoseidonHasher, type ProofProvider, type SerializedProof,
} from '../../src/protocol/index.js'
import { FIELD_SIZE, toBytes } from '../../src/protocol/validation.js'

const config = DEVNET
const publicWallet = Keypair.fromSeed(new Uint8Array(32).fill(7))
const otherPublicWallet = Keypair.fromSeed(new Uint8Array(32).fill(8))
const recipient = new PublicKey(new Uint8Array(32).fill(19))
const hasher: PoseidonHasher = values => values.reduce((sum, value, index) => (sum * 131n + value * BigInt(index + 2) + 1n) % FIELD_SIZE, 17n)
const bytes32 = (value: string | bigint) => Array.from(toBytes(BigInt(value), 32))
const decimal = (bytes: Uint8Array | readonly number[]) => BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString()
const publicProof = (input: CircuitInput): SerializedProof => ({
  proofA: Array(64).fill(1), proofB: Array(128).fill(2), proofC: Array(64).fill(3),
  root: bytes32(input.root), publicAmount: bytes32(input.publicAmount), extDataHash: bytes32(input.extDataHash),
  inputNullifiers: input.inputNullifier.map(bytes32), outputCommitments: input.outputCommitment.map(bytes32),
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const info = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 })

async function fixture(options: { initialBalance?: bigint; timeoutMs?: number } = {}) {
  const program = new PublicKey(config.programId)
  const programAccounts = getProgramAccounts(program)
  const shutdown = PublicKey.findProgramAddressSync([Buffer.from('shutdown')], program)[0]
  const bump = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[1]
  const tree = new MerkleTree(hasher)
  const roots = new Array<string>(100).fill('0'); roots[0] = tree.root()
  const leaves: LeafRecord[] = []
  const markers = new Map<string, AccountInfo<Buffer>>()
  const calls = { genesis: 0, accounts: 0, signMessage: 0, signTransaction: 0, send: 0, relay: 0, ingest: 0, status: 0, prove: 0 }
  let currentPublicKey = publicWallet.publicKey
  let maliciousWallet = false
  let invalidSignature = false
  let sendMode: 'ok' | 'throw' | 'hang' = 'ok'
  let relayMode: 'ok' | '400' = 'ok'
  let hangGenesis = false
  let hangAccounts = false
  let hangStatuses = false
  let sentBytes: Uint8Array | undefined
  let relayBody: { proof: SerializedProof; encryptedOutput1: string; encryptedOutput2: string } | undefined
  let sendOptions: unknown
  let rpcStatus: { err: unknown; confirmationStatus: 'confirmed' | 'finalized' } | null = null
  const prover: ProofProvider = { prove: async input => { calls.prove++; return publicProof(input) } }
  const wallet: WalletSigner = {
    get publicKey() { return currentPublicKey },
    async signMessage(message) { calls.signMessage++; return nacl.sign.detached(message, publicWallet.secretKey) },
    async signTransaction(transaction) {
      calls.signTransaction++
      const signed = VersionedTransaction.deserialize(transaction.serialize())
      if (maliciousWallet) signed.message.recentBlockhash = otherPublicWallet.publicKey.toBase58()
      signed.sign([publicWallet])
      if (invalidSignature) signed.signatures[0] = new Uint8Array(64)
      return signed
    },
  }
  function append(commitment: string, encryptedOutput: string): void {
    leaves.push({ index: leaves.length, commitment, encryptedOutput })
    tree.append(commitment)
    roots[leaves.length % 100] = tree.root()
  }
  function spend(nullifiers: readonly string[]): void {
    for (const nullifier of nullifiers) markers.set(nullifierPdaFor(program, nullifier).toBase58(), info(Buffer.from([250, 31, 238, 177, 213, 98, 48, 172, 0]), program))
  }
  function applyBuilt(built: BuiltTransaction): void {
    append(built.outputCommitments[0]!, Buffer.from(built.encryptedOutput1).toString('hex'))
    append(built.outputCommitments[1]!, Buffer.from(built.encryptedOutput2).toString('hex'))
    spend(built.proof.inputNullifiers.map(decimal))
  }
  function chainAccounts(): Map<string, AccountInfo<Buffer> | null> {
    const treeData = Buffer.alloc(4136)
    Buffer.from([147, 200, 34, 248, 131, 187, 248, 253]).copy(treeData)
    publicWallet.publicKey.toBuffer().copy(treeData, 8)
    treeData.writeBigUInt64LE(BigInt(leaves.length), 40)
    Buffer.from(bytes32(tree.root())).copy(treeData, 880)
    roots.forEach((root, index) => Buffer.from(bytes32(root)).copy(treeData, 912 + index * 32))
    treeData.writeBigUInt64LE(BigInt(leaves.length % 100), 4112)
    treeData.writeBigUInt64LE(1_000_000_000_000n, 4120)
    treeData[4128] = 26; treeData[4129] = 100; treeData[4130] = bump('merkle_tree')
    const globalData = Buffer.alloc(48)
    Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]).copy(globalData)
    publicWallet.publicKey.toBuffer().copy(globalData, 8)
    globalData.writeUInt16LE(20, 42); globalData[46] = bump('global_config')
    return new Map([[programAccounts.treeAccount.toBase58(), info(treeData, program)],
      [programAccounts.globalConfig.toBase58(), info(globalData, program)], [shutdown.toBase58(), null]])
  }
  const connection = {
    async getGenesisHash() { calls.genesis++; return hangGenesis ? new Promise<string>(() => {}) : config.genesisHash },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.accounts++
      if (hangAccounts) return new Promise<(AccountInfo<Buffer> | null)[]>(() => {})
      assert(keys.length > 0 && keys.length <= 100)
      const pool = chainAccounts()
      return keys.map(key => pool.get(key.toBase58()) ?? markers.get(key.toBase58()) ?? null)
    },
    async getLatestBlockhash() { return { blockhash: recipient.toBase58(), lastValidBlockHeight: 12345 } },
    async sendRawTransaction(bytes: Uint8Array, sendOpts: unknown) {
      calls.send++; sentBytes = Uint8Array.from(bytes); sendOptions = sendOpts
      if (sendMode === 'throw') throw new Error('Simulated ambiguous submission failure')
      if (sendMode === 'hang') return new Promise<string>(() => {})
      return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!)
    },
    async getSignatureStatuses() {
      calls.status++
      if (hangStatuses) return new Promise<never>(() => {})
      return { context: { slot: 1 }, value: [rpcStatus] }
    },
  } as unknown as Connection
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, new URL(config.apiUrl).origin)
    const path = url.pathname
    if (path === '/api/state') return json({
      programId: config.programId, relayer: config.relayer, root: tree.root(), leafCount: leaves.length,
      chainLeaves: leaves.length, indexedLeaves: leaves.length, withdrawFeeBps: 20, baseFeeLamports: 6_000_000,
      feeModel: 'gross-percentage-plus-fixed-v1', shutdownAt: null, relayerEnabled: true, faucetEnabled: false,
      rpcUrl: 'https://this-value-is-never-used.invalid',
    })
    if (path === '/api/leaves') {
      assert(!init?.body, 'No private owned-note filter is sent to the indexer')
      const from = Number(url.searchParams.get('from')), limit = Number(url.searchParams.get('limit'))
      return json({ leaves: leaves.slice(from, from + limit), total: leaves.length })
    }
    if (path === '/api/relay') {
      calls.relay++
      const encoded = String(init?.body)
      assert(!/inPrivateKey|inBlinding|spendSecret|privateWitness/.test(encoded))
      relayBody = JSON.parse(encoded) as NonNullable<typeof relayBody>
      return relayMode === '400' ? json({ error: 'Ambiguous server failure after possible submission' }, 400)
        : json({ signature: bs58.encode(new Uint8Array(64).fill(31)), confirmed: true })
    }
    if (path === '/api/ingest') { calls.ingest++; return json({ contiguous: leaves.length }) }
    throw new Error(`Unexpected offline route: ${path}`)
  }
  if (options.initialBalance) {
    const message = createUnlockMessage(publicWallet.publicKey, config, 'app.zkpay.sh')
    const sig = nacl.sign.detached(message, publicWallet.secretKey)
    const digest = sha256(Buffer.concat([Buffer.from('zkpay/spend/v1'), Buffer.from(sig)]))
    const secret = new Uint8Array(32); secret.set(digest.subarray(0, 31), 1)
    const fundingAccount = new ProtocolAccount(secret, hasher)
    secret.fill(0); digest.fill(0); sig.fill(0)
    try {
      applyBuilt(await fundingAccount.buildDeposit({ tree, amount: options.initialBalance, notes: [], feeRecipient: new PublicKey(config.relayer), prover }))
    } finally { fundingAccount.dispose() }
  }
  calls.prove = 0
  const reopen = () => ZkPayClient.create({ network: config.network, wallet, connection, fetch, hasher, prover,
    signingHost: 'app.zkpay.sh', timeoutMs: options.timeoutMs ?? 500 })
  const client = await reopen()
  function applySent(options: { markSpent?: boolean } = {}): void {
    assert(sentBytes)
    const tx = VersionedTransaction.deserialize(sentBytes)
    const ix = tx.message.compiledInstructions.at(-1)!
    const data = Buffer.from(ix.data)
    assert.equal(data.length, 662)
    const length0 = data.readUInt32LE(504)
    const length1Position = 508 + length0
    const length1 = data.readUInt32LE(length1Position)
    append(decimal(data.subarray(424, 456)), data.subarray(508, 508 + length0).toString('hex'))
    append(decimal(data.subarray(456, 488)), data.subarray(length1Position + 4, length1Position + 4 + length1).toString('hex'))
    if (options.markSpent !== false) spend([decimal(data.subarray(360, 392)), decimal(data.subarray(392, 424))])
  }
  function applyRelay(): void {
    assert(relayBody)
    append(decimal(relayBody.proof.outputCommitments[0]!), relayBody.encryptedOutput1)
    append(decimal(relayBody.proof.outputCommitments[1]!), relayBody.encryptedOutput2)
    spend(relayBody.proof.inputNullifiers.map(decimal))
  }
  return { client, reopen, calls, program, tree, leaves, markers, applySent, applyRelay, spend,
    sendOptions: () => sendOptions, sentBytes: () => sentBytes,
    setSendMode: (mode: typeof sendMode) => { sendMode = mode }, setRelayMode: (mode: typeof relayMode) => { relayMode = mode },
    switchWallet: () => { currentPublicKey = otherPublicWallet.publicKey },
    setMaliciousWallet: () => { maliciousWallet = true }, setInvalidSignature: () => { invalidSignature = true },
    hangGenesis: (value = true) => { hangGenesis = value }, hangAccounts: (value = true) => { hangAccounts = value }, hangStatuses: (value = true) => { hangStatuses = value },
    setRpcStatus: (value: typeof rpcStatus) => { rpcStatus = value },
    expireRoot: () => { for (let index = 0; index < 100; index++) append(String(100000 + index), '') },
  }
}

test('create is offline, unlock is cached, and real encrypted fixture notes are scanned locally', async context => {
  const f = await fixture({ initialBalance: 1_000_000_000n }); context.after(() => f.client.dispose())
  assert.equal(f.calls.genesis, 0)
  assert.equal(f.calls.signMessage, 0)
  assert.equal(f.client.isUnlocked, false)
  await f.client.unlock(); await f.client.unlock()
  assert.equal(f.calls.signMessage, 1)
  const balance = await f.client.getPrivateBalance()
  assert.equal(balance.verified, true)
  assert.equal(balance.balanceLamports, 1_000_000_000n)
  assert.equal(balance.spendableLamports, 1_000_000_000n)
  assert.equal(balance.noteCount, 1)
  assert.equal(balance.leafCount, 2)
  assert.equal(f.calls.send + f.calls.relay, 0)
})

test('ambiguous deposit sends once, retains its locally signed identity and prevents preparation or replay', async context => {
  const f = await fixture(); context.after(() => f.client.dispose())
  await f.client.unlock()
  const prepared = await f.client.prepareDeposit({ lamports: 1_000_000_000n })
  assert.equal(f.calls.signTransaction, 0)
  f.setSendMode('throw')
  let unknown: PendingPayment | undefined
  await assert.rejects(f.client.submitDeposit(prepared), (error: unknown) => {
    assert(error instanceof SubmissionUnknownError)
    unknown = error.payment
    return true
  })
  assert(unknown?.signature)
  assert.equal(unknown.status, 'unknown')
  assert.equal(f.calls.send, 1)
  assert.equal(f.calls.signTransaction, 1)
  assert.deepEqual(f.sendOptions(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
  assert.equal(f.client.pendingPayment, unknown)
  await assert.rejects(f.client.submitDeposit(prepared), /pending or unknown/)
  await assert.rejects(f.client.prepareDeposit({ lamports: 1n }), /pending or unknown/)
  assert.equal(f.calls.send, 1)
  assert.equal(f.calls.prove, 1)
  assert(!/inPrivateKey|inBlinding|spendSecret/.test(JSON.stringify(unknown.intent)))
  f.applySent()
  assert.equal((await f.client.getPaymentStatus(unknown)).status, 'confirmed')
  assert.equal(f.client.pendingPayment, undefined)
})

test('deposit confirms only after adjacent outputs and both reserved-bump-zero nullifiers appear on chain', async context => {
  const f = await fixture(); context.after(() => f.client.dispose())
  await f.client.unlock()
  const pending = await f.client.deposit({ lamports: 1_000_000_000n })
  assert.equal(pending.status, 'submitted')
  f.setRpcStatus({ err: null, confirmationStatus: 'confirmed' })
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'submitted', 'RPC confirmed is not a proof of the expected effects')
  f.applySent({ markSpent: false })
  await assert.rejects(f.client.getPaymentStatus(pending), /spent inputs/)
  f.spend(pending.intent.inputNullifiers)
  const status = await f.client.getPaymentStatus(pending)
  assert.equal(status.status, 'confirmed')
  if (status.status === 'confirmed') assert.equal(status.verifiedBy, 'pool-effects')
  assert.equal((await f.client.getPrivateBalance()).balanceLamports, 1_000_000_000n)
  assert.equal(f.calls.send, 1)
})

test('withdrawal quotes gross, ignores relayer confirmed and independently scans encrypted change', async context => {
  const f = await fixture({ initialBalance: 1_000_000_000n }); context.after(() => f.client.dispose())
  await f.client.unlock()
  const prepared = await f.client.prepareWithdrawal({ lamports: 500_000_000n, recipient })
  assert.equal(prepared.quote.feeLamports, 7_000_000n)
  assert.equal(prepared.quote.recipientLamports, 493_000_000n)
  assert.equal(f.calls.signTransaction, 0)
  const pending = await f.client.submitWithdrawal(prepared)
  assert.equal(pending.status, 'submitted')
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'submitted')
  f.setRpcStatus({ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' })
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'submitted', 'A relayer-supplied unrelated failed signature must not unlock retry')
  f.applyRelay()
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'confirmed')
  assert.equal((await f.client.getPrivateBalance()).balanceLamports, 500_000_000n)
  assert.equal(f.calls.relay, 1)
  assert.equal(f.calls.send, 0)
})

test('HTTP 400 withdrawal stays unknown, is never retried, and can recover by effects without a signature', async context => {
  const f = await fixture({ initialBalance: 1_000_000_000n }); context.after(() => f.client.dispose())
  await f.client.unlock()
  const prepared = await f.client.prepareWithdrawal({ lamports: 500_000_000n, recipient })
  f.setRelayMode('400')
  await assert.rejects(f.client.submitWithdrawal(prepared), SubmissionUnknownError)
  const pending = f.client.pendingPayment!
  assert.equal(pending.status, 'unknown')
  assert.equal(pending.signature, undefined)
  await assert.rejects(f.client.submitWithdrawal(prepared), /pending or unknown/)
  await assert.rejects(f.client.send({ lamports: 10_000_000n, recipient }), /pending or unknown/)
  assert.equal(f.calls.relay, 1)
  f.applyRelay()
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'confirmed')
  assert.equal(f.client.pendingPayment, undefined)
})

test('wallet account switches and malicious signed-message changes stop before submission', async context => {
  for (const attack of ['switch', 'mutate', 'invalid-signature'] as const) {
    const f = await fixture(); context.after(() => f.client.dispose())
    await f.client.unlock()
    const prepared = await f.client.prepareDeposit({ lamports: 1_000_000n })
    const original = prepared.transaction.message.serialize().slice()
    if (attack === 'switch') f.switchWallet()
    if (attack === 'mutate') f.setMaliciousWallet()
    if (attack === 'invalid-signature') f.setInvalidSignature()
    await assert.rejects(f.client.submitDeposit(prepared), /Wallet|wallet|signature/)
    assert.equal(f.calls.send, 0)
    assert.equal(f.client.pendingPayment, undefined)
    assert.deepEqual(prepared.transaction.message.serialize(), original)
  }
})

test('mutating the prepared transaction or expiring its root never requests a wallet signature', async context => {
  for (const attack of ['message', 'root'] as const) {
    const f = await fixture(); context.after(() => f.client.dispose())
    await f.client.unlock()
    const prepared = await f.client.prepareDeposit({ lamports: 1_000_000n })
    if (attack === 'message') prepared.transaction.message.recentBlockhash = otherPublicWallet.publicKey.toBase58()
    else f.expireRoot()
    await assert.rejects(f.client.submitDeposit(prepared), /modified|expired/)
    assert.equal(f.calls.signTransaction, 0)
    assert.equal(f.calls.send, 0)
  }
})

test('prefunded empty system nullifier PDAs do not block a valid prepared deposit', async context => {
  const f = await fixture(); context.after(() => f.client.dispose())
  await f.client.unlock()
  const prepared = await f.client.prepareDeposit({ lamports: 1_000_000n })
  for (const nullifier of prepared.intent.inputNullifiers) {
    f.markers.set(nullifierPdaFor(f.program, nullifier).toBase58(), info(Buffer.alloc(0), SystemProgram.programId))
  }
  assert.equal((await f.client.submitDeposit(prepared)).status, 'submitted')
  assert.equal(f.calls.send, 1)
})

test('injected hanging RPCs time out, including a send that must preserve unknown status', async context => {
  const keepAlive = setInterval(() => {}, 100); context.after(() => clearInterval(keepAlive))
  const f = await fixture({ timeoutMs: 15 }); context.after(() => f.client.dispose())
  f.hangGenesis()
  await assert.rejects(f.client.unlock(), /timed out/)
  assert.equal(f.calls.signMessage, 0)
  f.hangGenesis(false)
  await f.client.unlock()
  f.hangAccounts()
  await assert.rejects(f.client.getPrivateBalance(), /timed out/)
  f.hangAccounts(false)
  const prepared = await f.client.prepareDeposit({ lamports: 1_000_000n })
  f.setSendMode('hang')
  await assert.rejects(f.client.submitDeposit(prepared), SubmissionUnknownError)
  assert.equal(f.calls.send, 1)
  assert.equal(f.client.pendingPayment?.status, 'unknown')
})

test('confirmation wait honors its overall deadline even when an injected RPC never settles', async context => {
  const keepAlive = setInterval(() => {}, 100); context.after(() => clearInterval(keepAlive))
  const f = await fixture({ timeoutMs: 500 }); context.after(() => f.client.dispose())
  await f.client.unlock()
  const pending = await f.client.deposit({ lamports: 1_000_000n })
  f.hangStatuses()
  const started = performance.now()
  const result = await f.client.waitForConfirmation(pending, { timeoutMs: 25, pollIntervalMs: 100 })
  assert.equal(result.status, 'submitted')
  assert(performance.now() - started < 250, 'The overall polling deadline must beat the 500ms per-RPC timeout')
  assert.equal(f.client.pendingPayment?.intent.id, pending.intent.id)
  f.hangStatuses(false)
  f.applySent()
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'confirmed')
})

test('resumed payment metadata is copied and cannot be modified while it is tracked', async context => {
  const first = await fixture(); context.after(() => first.client.dispose())
  await first.client.unlock(); first.setSendMode('throw')
  await assert.rejects(first.client.deposit({ lamports: 1_000_000n }), SubmissionUnknownError)
  const original = first.client.pendingPayment!
  const second = await fixture(); context.after(() => second.client.dispose())
  await second.client.unlock()
  const mutable = JSON.parse(JSON.stringify(original)) as PendingPayment
  second.client.resumePayment(mutable)
  ;(mutable.intent as { recipient: string }).recipient = recipient.toBase58()
  assert.equal(second.client.pendingPayment?.intent.recipient, config.relayer)
  await assert.rejects(second.client.getPaymentStatus(mutable), /Invalid payment fee|does not match|authentication/)
  assert.equal(second.calls.send + second.calls.relay, 0)
})

test('a restarted client authenticates real prepared intent economics before confirming existing chain effects', async context => {
  const f = await fixture({ initialBalance: 1_000_000_000n }); context.after(() => f.client.dispose())
  await f.client.unlock()
  const prepared = await f.client.prepareWithdrawal({ lamports: 500_000_000n, recipient })
  assert.match(prepared.intent.authentication, /^[a-f0-9]{64}$/)
  const pending = await f.client.submitWithdrawal(prepared)
  f.applyRelay()
  assert.equal((await f.client.getPaymentStatus(pending)).status, 'confirmed')
  f.client.dispose()

  const restarted = await f.reopen(); context.after(() => restarted.dispose())
  await restarted.unlock()
  const before = { sends: f.calls.send, relays: f.calls.relay, proofs: f.calls.prove, reads: f.calls.accounts }
  for (const change of [
    { grossLamports: '600000000', feeLamports: '7200000' },
    { recipient: otherPublicWallet.publicKey.toBase58() },
    { id: pending.intent.id === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32) },
    { authentication: '0'.repeat(64) },
  ]) {
    const forged = JSON.parse(JSON.stringify(pending)) as PendingPayment
    Object.assign(forged.intent, change)
    assert.throws(() => restarted.resumePayment(forged), /authentication/)
    await assert.rejects(restarted.getPaymentStatus(forged), /authentication/)
    assert.equal(restarted.pendingPayment, undefined)
  }
  assert.equal(f.calls.accounts, before.reads, 'Forged metadata is rejected before any chain-effect check')
  const restored = JSON.parse(JSON.stringify(pending)) as PendingPayment
  restarted.resumePayment(restored)
  assert.equal((await restarted.getPaymentStatus(restored)).status, 'confirmed')
  assert.equal(f.calls.send, before.sends)
  assert.equal(f.calls.relay, before.relays)
  assert.equal(f.calls.prove, before.proofs)
})
