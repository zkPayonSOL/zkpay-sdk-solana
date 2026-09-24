import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import { ZkPayClient, type ClientOptions } from '../../src/client.js'
import { MAINNET } from '../../src/networks.js'
import { createKeypairWallet, type WalletSigner } from '../../src/wallet.js'
import { FIELD_SIZE, MerkleTree, type PoseidonHasher } from '../../src/protocol/index.js'

const explicitPublicRpc = 'https://api.mainnet-beta.solana.com'
const fakeHasher: PoseidonHasher = inputs => inputs.reduce((sum, value, index) => (sum + value * BigInt(index + 2)) % FIELD_SIZE, 1n)
const noProof = { async prove(): Promise<never> { throw new Error('RPC selection checks must not request a proof') } }

// This function is never called. The regular project typecheck checks both positive and negative API examples.
function rpcSelectionTypechecks(wallet: WalletSigner, connection: Connection): void {
  const byUrl: ClientOptions = { network: 'mainnet-beta', wallet, rpcUrl: explicitPublicRpc }
  const byConnection: ClientOptions = { network: 'mainnet-beta', wallet, connection }
  // @ts-expect-error An RPC URL or an owned Connection is mandatory.
  const missing: ClientOptions = { network: 'mainnet-beta', wallet }
  // @ts-expect-error Supplying both RPC choices is ambiguous and forbidden.
  const both: ClientOptions = { network: 'mainnet-beta', wallet, rpcUrl: explicitPublicRpc, connection }
  void [byUrl, byConnection, missing, both]
}
void rpcSelectionTypechecks

function walletFixture() {
  // Public deterministic test seed, never funded and never loaded from a wallet file.
  const base = createKeypairWallet(Keypair.fromSeed(new Uint8Array(32).fill(31)))
  const calls = { message: 0, transaction: 0 }
  const wallet: WalletSigner = {
    publicKey: base.publicKey,
    async signMessage(message) { calls.message++; return base.signMessage(message) },
    async signTransaction(transaction) { calls.transaction++; return base.signTransaction(transaction) },
  }
  return { wallet, calls }
}

test('JavaScript callers must select exactly one valid RPC before any wallet, fetch or hasher work', async () => {
  const { wallet, calls } = walletFixture()
  const connection = { getGenesisHash: async () => MAINNET.genesisHash } as unknown as Connection
  let fetched = 0
  let hasherAccessed = 0
  const fetcher: typeof fetch = async () => { fetched++; throw new Error('No network access is allowed in invalid-option checks') }
  const invalid: Record<string, unknown>[] = [
    {}, { rpcUrl: undefined }, { rpcUrl: null }, { rpcUrl: '' }, { rpcUrl: '   ' },
    { rpcUrl: 'not-a-url' }, { rpcUrl: 'http://remote-rpc.invalid' },
    { rpcUrl: 'https://name:secret@rpc.invalid' }, { rpcUrl: 'https://rpc.invalid/#fragment' },
    { rpcUrl: 'file:///tmp/rpc' }, { rpcUrl: 123 },
    { connection: null }, { connection: {} }, { connection: { getGenesisHash: 'not-a-function' } },
    { rpcUrl: explicitPublicRpc, connection }, { rpcUrl: null, connection },
  ]
  for (const selection of invalid) {
    const runtime = { network: 'mainnet-beta', wallet, fetch: fetcher, prover: noProof, ...selection }
    Object.defineProperty(runtime, 'hasher', { enumerable: true, get() { hasherAccessed++; return fakeHasher } })
    await assert.rejects(ZkPayClient.create(runtime as unknown as ClientOptions), `should reject ${JSON.stringify(selection)}`)
  }
  await assert.rejects(ZkPayClient.create(null as unknown as ClientOptions))
  assert.equal(fetched, 0)
  assert.equal(hasherAccessed, 0)
  assert.deepEqual(calls, { message: 0, transaction: 0 })
})

test('network and wallet validation precede RPC selection and never trigger an implicit default', async () => {
  const { wallet, calls } = walletFixture()
  let touchedRpcSelection = 0
  const wrongNetwork = { network: 'devnet', wallet }
  Object.defineProperty(wrongNetwork, 'rpcUrl', { get() { touchedRpcSelection++; throw new Error('RPC selection ran too early') } })
  await assert.rejects(ZkPayClient.create(wrongNetwork as unknown as ClientOptions), /Mainnet|mainnet/i)
  const wrongWallet = { network: 'mainnet-beta', wallet: {} }
  Object.defineProperty(wrongWallet, 'rpcUrl', { get() { touchedRpcSelection++; throw new Error('RPC selection ran too early') } })
  await assert.rejects(ZkPayClient.create(wrongWallet as unknown as ClientOptions), /wallet/i)
  assert.equal(touchedRpcSelection, 0)
  assert.equal(calls.message, 0)
  assert.equal(Object.hasOwn(MAINNET, 'rpcUrl'), false, 'the pinned Mainnet identity must not contain a fallback RPC')
})

test('an explicit public Mainnet RPC uses the caller fetch channel and ignores API-advertised RPC URLs', async () => {
  const { wallet, calls } = walletFixture()
  const program = new PublicKey(MAINNET.programId)
  const bump = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[1]
  const root = new MerkleTree(fakeHasher).root()
  const rootBytes = Buffer.from(BigInt(root).toString(16).padStart(64, '0'), 'hex')
  const tree = Buffer.alloc(4136)
  Buffer.from([147, 200, 34, 248, 131, 187, 248, 253]).copy(tree)
  tree.fill(7, 8, 40)
  rootBytes.copy(tree, 880); rootBytes.copy(tree, 912)
  tree.writeBigUInt64LE(1_000_000_000_000n, 4120)
  tree[4128] = 26; tree[4129] = 100; tree[4130] = bump('merkle_tree')
  const global = Buffer.alloc(48)
  Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]).copy(global)
  global.fill(7, 8, 40); global.writeUInt16LE(20, 42); global[46] = bump('global_config')
  const wireAccount = (data: Buffer) => ({ data: [data.toString('base64'), 'base64'], owner: MAINNET.programId, executable: false, lamports: 1, rentEpoch: 0 })
  const requested: { url: string; method: string }[] = []
  const advertisedRpc = 'https://must-not-be-used.invalid/untrusted-advertisement'
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    assert.notEqual(url, advertisedRpc)
    assert.equal(init?.redirect, 'error')
    if (url === `${MAINNET.apiUrl}/state`) {
      requested.push({ url, method: 'state' })
      return new Response(JSON.stringify({
        network: 'mainnet-beta', genesisHash: MAINNET.genesisHash, programId: MAINNET.programId, relayer: MAINNET.relayer,
        root, leafCount: 0, chainLeaves: 0, indexedLeaves: 0, feeModel: 'gross-percentage-plus-fixed-v1',
        withdrawFeeBps: 20, baseFeeLamports: 6_000_000, shutdownAt: null, rpcUrl: advertisedRpc,
        relayerEnabled: true, faucetEnabled: false,
      }), { headers: { 'content-type': 'application/json' } })
    }
    assert.equal(init?.credentials, 'omit')
    assert.equal(new URL(url).href, new URL(explicitPublicRpc).href, 'all RPC calls must stay on the caller-selected endpoint')
    const body = JSON.parse(String(init?.body)) as { id: string; method: string }
    requested.push({ url, method: body.method })
    let result: unknown
    if (body.method === 'getGenesisHash') result = MAINNET.genesisHash
    else if (body.method === 'getMultipleAccounts') result = { context: { slot: 100 }, value: [wireAccount(tree), wireAccount(global), null] }
    else throw new Error(`Unexpected RPC method in read-only fixture: ${body.method}`)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const client = await ZkPayClient.create({
    network: 'mainnet-beta', wallet, rpcUrl: explicitPublicRpc, fetch: fetcher, hasher: fakeHasher, prover: noProof,
  })
  try {
    assert.equal(requested.length, 0, 'creating a client must not connect to any RPC or API')
    await client.unlock()
    assert.equal(client.isUnlocked, true)
    const balance = await client.getPrivateBalance()
    assert.equal(balance.balanceLamports, 0n)
    assert.equal(balance.verified, true)
    assert.ok(requested.some(request => request.method === 'state'))
    assert.ok(requested.some(request => request.method === 'getGenesisHash'))
    assert.ok(requested.some(request => request.method === 'getMultipleAccounts'))
    assert.equal(new URL(client.config.rpcUrl!).href, new URL(explicitPublicRpc).href)
    assert.equal(calls.message, 1)
    assert.equal(calls.transaction, 0)
  } finally { client.dispose() }
})

test('an explicitly injected Connection unlocks without constructing or falling back to another RPC', async () => {
  const { wallet, calls } = walletFixture()
  let genesisCalls = 0
  let fetchCalls = 0
  const connection = {
    getGenesisHash: async () => { genesisCalls++; return MAINNET.genesisHash },
  } as unknown as Connection
  const client = await ZkPayClient.create({
    network: 'mainnet-beta', wallet, connection, hasher: fakeHasher, prover: noProof,
    fetch: async () => { fetchCalls++; throw new Error('An injected Connection must own its RPC transport') },
  })
  try {
    assert.equal(genesisCalls, 0)
    await client.unlock()
    assert.equal(client.isUnlocked, true)
    assert.equal(genesisCalls, 1)
    assert.equal(fetchCalls, 0)
    assert.equal(calls.message, 1)
    assert.equal(calls.transaction, 0)
  } finally { client.dispose() }
})

test('an explicitly selected non-Mainnet connection still fails before requesting an unlock signature', async () => {
  const { wallet, calls } = walletFixture()
  let genesisCalls = 0
  const connection = {
    getGenesisHash: async () => { genesisCalls++; return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
  } as unknown as Connection
  const client = await ZkPayClient.create({ network: 'mainnet-beta', wallet, connection, hasher: fakeHasher, prover: noProof })
  try {
    await assert.rejects(client.unlock())
    assert.equal(client.isUnlocked, false)
    assert.equal(genesisCalls, 1)
    assert.equal(calls.message, 0)
    assert.equal(calls.transaction, 0)
  } finally { client.dispose() }
})
