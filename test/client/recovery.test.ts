import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import bs58 from 'bs58'
import { ZkPayClient, type PaymentIntent, type PendingPayment } from '../../src/client.js'
import { DEVNET } from '../../src/networks.js'
import { createKeypairWallet, deriveSpendingSecret } from '../../src/wallet.js'
import { FIELD_SIZE, MerkleTree, type PoseidonHasher } from '../../src/protocol/index.js'

const hasher: PoseidonHasher = inputs => inputs.reduce((sum, value, index) => (sum + value * BigInt(index + 2)) % FIELD_SIZE, 1n)
const publicSignature = bs58.encode(new Uint8Array(64).fill(7))
const anotherSignature = bs58.encode(new Uint8Array(64).fill(8))
const be32 = (value: string) => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex')

async function fixture(options: { walletSeed?: number; unlocked?: boolean } = {}) {
  // A fixed public test seed; no wallet files, live RPC or live API calls.
  const wallet = createKeypairWallet(Keypair.fromSeed(new Uint8Array(32).fill(options.walletSeed ?? 23)))
  const spendSecret = await deriveSpendingSecret(wallet, DEVNET, 'app.zkpay.sh')
  const authenticationKey = sha256(Buffer.concat([Buffer.from('zkpay/sdk/payment-intent-key/v1'), Buffer.from(spendSecret)]))
  spendSecret.fill(0)
  const authenticate = (input: Omit<PaymentIntent, 'authentication'>): PaymentIntent => {
    const body = {
      id: input.id, kind: input.kind, network: input.network, programId: input.programId,
      root: input.root, grossLamports: input.grossLamports, feeLamports: input.feeLamports, recipient: input.recipient,
      inputNullifiers: [...input.inputNullifiers], outputCommitments: [...input.outputCommitments],
    }
    return { ...body, authentication: Buffer.from(hmac(sha256, authenticationKey, Buffer.from(JSON.stringify(body)))).toString('hex') }
  }
  const program = new PublicKey(DEVNET.programId)
  const bump = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[1]
  const root = new MerkleTree(hasher).root()
  const tree = Buffer.alloc(4136)
  Buffer.from([147, 200, 34, 248, 131, 187, 248, 253]).copy(tree)
  tree.fill(7, 8, 40)
  be32(root).copy(tree, 880); be32(root).copy(tree, 912)
  tree.writeBigUInt64LE(1_000_000_000_000n, 4120)
  tree[4128] = 26; tree[4129] = 100; tree[4130] = bump('merkle_tree')
  const global = Buffer.alloc(48)
  Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]).copy(global)
  global.fill(7, 8, 40); global.writeUInt16LE(20, 42); global[46] = bump('global_config')
  const info = (data: Buffer): AccountInfo<Buffer> => ({ data, owner: program, executable: false, lamports: 1, rentEpoch: 0 })
  const connection = {
    getGenesisHash: async () => DEVNET.genesisHash,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.length === 3 ? [info(tree), info(global), null] : keys.map(() => null),
    getSignatureStatuses: async () => ({ context: { slot: 100 }, value: [{ slot: 99, confirmations: null, confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } }] }),
  } as unknown as Connection
  const fetcher: typeof fetch = async request => {
    assert.ok(String(request).endsWith('/state'), 'recovery should only need the empty-pool state endpoint')
    return new Response(JSON.stringify({
      network: DEVNET.network, genesisHash: DEVNET.genesisHash, programId: DEVNET.programId, relayer: DEVNET.relayer,
      root, leafCount: 0, chainLeaves: 0, indexedLeaves: 0, feeModel: 'gross-percentage-plus-fixed-v1',
      withdrawFeeBps: 20, baseFeeLamports: 6_000_000, shutdownAt: null, rpcUrl: '/api/rpc', relayerEnabled: true, faucetEnabled: false,
    }), { headers: { 'content-type': 'application/json' } })
  }
  const client = await ZkPayClient.create({
    network: 'devnet', wallet, connection, fetch: fetcher, hasher,
    prover: { async prove() { throw new Error('recovery must not invoke the prover') } },
  })
  if (options.unlocked !== false) await client.unlock()
  const intent = authenticate({
    id: 'a'.repeat(32), kind: 'deposit', network: 'devnet', programId: DEVNET.programId,
    root, grossLamports: '10000000', feeLamports: '0', recipient: DEVNET.relayer,
    inputNullifiers: ['101', '102'], outputCommitments: ['201', '202'],
  })
  const payment: PendingPayment = { status: 'submitted', intent, signature: publicSignature }
  return { client, payment, authenticate }
}

test('resumed tracking metadata is copied, frozen and contains no accidental secret properties', async () => {
  const { client, payment } = await fixture()
  const source = structuredClone(payment) as PendingPayment & { privateWitness?: string }
  source.privateWitness = 'must-not-be-retained'
  Object.assign(source.intent, { spendSecret: 'must-not-be-retained' })
  client.resumePayment(source)
  const tracked = client.pendingPayment!
  assert.equal(JSON.stringify(tracked).includes('must-not-be-retained'), false)
  assert.equal(Object.isFrozen(tracked), true)
  assert.equal(Object.isFrozen(tracked.intent), true)
  assert.equal(Object.isFrozen(tracked.intent.inputNullifiers), true)
  assert.equal(Object.isFrozen(tracked.intent.outputCommitments), true)
  ;(source.intent.inputNullifiers as string[])[0] = '999'
  assert.equal(tracked.intent.inputNullifiers[0], '101')
  client.dispose()
})

test('restored intents require canonical bounded metadata, consistent kind/fee and distinct nullifiers', async () => {
  const { client, payment } = await fixture()
  const invalidIntentPatches: Record<string, unknown>[] = [
    { grossLamports: '0x989680' }, { grossLamports: '010000000' }, { grossLamports: 10_000_000 },
    { grossLamports: '0' }, { grossLamports: ((1n << 63n) + 1n).toString() },
    { feeLamports: '-1' }, { feeLamports: '0x0' }, { feeLamports: 0 }, { feeLamports: '1' },
    { kind: 'withdrawal', feeLamports: '10000000' },
    { root: FIELD_SIZE.toString() }, { root: '01' },
    { inputNullifiers: ['101', '101'] }, { outputCommitments: ['201'] },
    { network: 'mainnet-beta' }, { programId: DEVNET.relayer }, { recipient: 'invalid' },
    { id: 'a'.repeat(31) }, { authentication: 'A'.repeat(64) }, { authentication: 'a'.repeat(63) },
    { authentication: undefined },
  ]
  for (const patch of invalidIntentPatches) {
    const malformed = { ...payment, intent: { ...payment.intent, ...patch } } as PendingPayment
    assert.throws(() => client.resumePayment(malformed), `should reject metadata patch ${JSON.stringify(patch)}`)
    assert.equal(client.pendingPayment, undefined)
  }
  assert.throws(() => client.resumePayment({ ...payment, status: 'confirmed' } as unknown as PendingPayment))
  assert.throws(() => client.resumePayment({ ...payment, signature: 'bad' }))
  client.dispose()
})

test('a matching random id cannot replace an unresolved payment even with a valid alternative authentication tag', async () => {
  const { client, payment, authenticate } = await fixture()
  client.resumePayment(payment)
  for (const body of [
    { ...payment.intent, root: '123' },
    { ...payment.intent, grossLamports: '11000000' },
    { ...payment.intent, recipient: DEVNET.programId },
    { ...payment.intent, inputNullifiers: ['301', '302'] },
    { ...payment.intent, outputCommitments: ['401', '402'] },
  ]) {
    const intent = authenticate(body)
    assert.throws(() => client.resumePayment({ ...payment, intent }))
    await assert.rejects(async () => client.getPaymentStatus({ ...payment, intent }))
    assert.deepEqual(client.pendingPayment!.intent, payment.intent)
  }
  assert.throws(() => client.resumePayment({ ...payment, signature: anotherSignature }))
  await assert.rejects(async () => client.getPaymentStatus({ ...payment, signature: anotherSignature }))
  assert.equal(client.pendingPayment!.signature, publicSignature)
  client.dispose()
})

test('an arbitrary recovered failed signature cannot mark a deposit failed or unlock another payment', async () => {
  const { client, payment } = await fixture()
  client.resumePayment(payment)
  const status = await client.getPaymentStatus(payment)
  assert.equal(status.status, 'submitted')
  assert.deepEqual(client.pendingPayment!.intent, payment.intent)
  await assert.rejects(client.prepareDeposit({ lamports: 1_000_000n }), /pending|unknown|unresolved/i)
  client.dispose()
})

test('the same wallet can authenticate its intact intent after a restart and preserve a known signature', async () => {
  const original = await fixture()
  const saved = JSON.parse(JSON.stringify(original.payment)) as PendingPayment
  original.client.dispose()
  const restarted = await fixture({ unlocked: false })
  assert.equal(restarted.client.isUnlocked, false)
  restarted.client.resumePayment(saved)
  assert.deepEqual(restarted.client.pendingPayment!.intent, saved.intent)
  await restarted.client.unlock()
  assert.equal(restarted.client.isUnlocked, true)
  const status = await restarted.client.getPaymentStatus(saved)
  assert.equal(status.status, 'submitted')
  restarted.client.resumePayment({ status: 'unknown', intent: saved.intent })
  assert.equal(restarted.client.pendingPayment!.signature, publicSignature)
  restarted.client.dispose()
})

test('restored authentication binds recipient, gross, fee, root, id and both effect arrays', async () => {
  const original = await fixture()
  const signed = original.authenticate({
    ...original.payment.intent, kind: 'withdrawal', feeLamports: '6020000',
    recipient: new PublicKey(new Uint8Array(32).fill(41)).toBase58(),
  })
  const saved: PendingPayment = { status: 'unknown', intent: signed }
  original.client.dispose()
  const restarted = await fixture()
  const patches: Partial<PaymentIntent>[] = [
    { recipient: new PublicKey(new Uint8Array(32).fill(42)).toBase58() },
    { grossLamports: '11000000' }, { feeLamports: '6020001' }, { root: '123' },
    { id: 'b'.repeat(32) }, { inputNullifiers: ['301', '302'] }, { outputCommitments: ['401', '402'] },
  ]
  for (const patch of patches) {
    const tampered = { ...saved, intent: { ...signed, ...patch } }
    // There is deliberately no preexisting in-memory pending intent to compare against.
    assert.equal(restarted.client.pendingPayment, undefined)
    assert.throws(() => restarted.client.resumePayment(tampered), /authentic|integrity|match|invalid/i)
    await assert.rejects(restarted.client.getPaymentStatus(tampered), /authentic|integrity|match|invalid/i)
  }
  restarted.client.resumePayment(saved)
  assert.equal((await restarted.client.getPaymentStatus(saved)).status, 'unknown')
  restarted.client.dispose()
})

test('a locked client may stage structurally valid metadata but unlock rejects its altered authentication', async () => {
  const original = await fixture()
  const tampered: PendingPayment = {
    ...original.payment, intent: { ...original.payment.intent, grossLamports: '11000000' },
  }
  original.client.dispose()
  const restarted = await fixture({ unlocked: false })
  assert.doesNotThrow(() => restarted.client.resumePayment(tampered))
  await assert.rejects(restarted.client.unlock(), /authentic|integrity|match|invalid/i)
  await assert.rejects(restarted.client.getPaymentStatus(tampered))
  restarted.client.dispose()
})

test('authentication from one public test wallet is rejected by a different wallet after restart', async () => {
  const original = await fixture({ walletSeed: 23 })
  const saved = structuredClone(original.payment)
  original.client.dispose()
  const other = await fixture({ walletSeed: 24, unlocked: false })
  other.client.resumePayment(saved)
  await assert.rejects(other.client.unlock(), /authentic|integrity|match|invalid/i)
  other.client.dispose()

  const alreadyUnlockedOther = await fixture({ walletSeed: 24 })
  assert.throws(() => alreadyUnlockedOther.client.resumePayment(saved), /authentic|integrity|match|invalid/i)
  await assert.rejects(alreadyUnlockedOther.client.getPaymentStatus(saved), /authentic|integrity|match|invalid/i)
  alreadyUnlockedOther.client.dispose()
})
