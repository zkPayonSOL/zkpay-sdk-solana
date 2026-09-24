import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { HttpApi, HttpApiError, RelaySubmissionUnknownError, type RelayRequest } from '../../src/transport.js'
import { DEVNET, MAINNET, type NetworkConfig } from '../../src/networks.js'
import { FIELD_SIZE, toBytes } from '../../src/protocol/validation.js'
import { extDataHashField } from '../../src/protocol/ext-data.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function state(config: NetworkConfig = MAINNET) {
  return { network: config.network, genesisHash: config.genesisHash, programId: config.programId, relayer: config.relayer,
    root: '1', leafCount: 2, chainLeaves: 2, indexedLeaves: 2, feeModel: 'gross-percentage-plus-fixed-v1',
    withdrawFeeBps: 20, baseFeeLamports: 6_000_000, shutdownAt: null, rpcUrl: '/api/mainnet/rpc', relayerEnabled: true, faucetEnabled: false }
}
const signature = bs58.encode(new Uint8Array(64).fill(3))
function relayBody(): RelayRequest {
  const recipient = new PublicKey(new Uint8Array(32).fill(11))
  const encryptedOutput1 = new Uint8Array(75).fill(1), encryptedOutput2 = new Uint8Array(75).fill(2)
  encryptedOutput2[0] = 1
  const extAmount = -992_000_000n, fee = 8_000_000n
  const field = (value: bigint) => Array.from(toBytes(value, 32))
  return { proof: { proofA: Array(64).fill(1), proofB: Array(128).fill(2), proofC: Array(64).fill(3),
    root: field(1n), publicAmount: field(FIELD_SIZE - 1_000_000_000n),
    extDataHash: field(BigInt(extDataHashField({ recipient, extAmount, fee, feeRecipient: new PublicKey(MAINNET.relayer), encryptedOutput1, encryptedOutput2 }))),
    inputNullifiers: [field(2n), field(3n)], outputCommitments: [field(4n), field(5n)] },
    extAmount: extAmount.toString(), fee: fee.toString(), recipient: recipient.toBase58(),
    encryptedOutput1: Buffer.from(encryptedOutput1).toString('hex'), encryptedOutput2: Buffer.from(encryptedOutput2).toString('hex') }
}

test('state checks both pool identities and live fee policy without replacing RPC', async () => {
  for (const config of [DEVNET, MAINNET]) {
    const info = await new HttpApi(config, { fetch: async () => json(state(config)) }).state()
    assert.equal(info.feePolicy.basisPoints, 20)
    assert.equal(info.feePolicy.baseLamports, 6_000_000n)
    assert.equal(info.rpcUrl, '/api/mainnet/rpc')
    for (const patch of [{ programId: DEVNET.relayer }, { relayer: MAINNET.programId }, { feeModel: 'legacy' }, { baseFeeLamports: 0 }, { withdrawFeeBps: 101 }]) {
      await assert.rejects(new HttpApi(config, { fetch: async () => json({ ...state(config), ...patch }) }).state(), HttpApiError)
    }
  }
  for (const patch of [{ network: undefined }, { genesisHash: DEVNET.genesisHash }, { faucetEnabled: true }]) {
    await assert.rejects(new HttpApi(MAINNET, { fetch: async () => json({ ...state(), ...patch }) }).state(), /Mainnet/)
  }
})

test('only canonical HTTPS endpoints or explicit localhost HTTP are accepted', () => {
  for (const apiUrl of ['http://outside.invalid/api', 'https://name:secret@localhost/api', 'https://localhost/api?key=secret', 'https://localhost/api#fragment']) {
    assert.throws(() => new HttpApi({ ...DEVNET, apiUrl }))
  }
  assert.doesNotThrow(() => new HttpApi({ ...DEVNET, apiUrl: 'http://localhost:1234/api' }))
})

test('GET retry is bounded to two retries and never leaks upstream error bodies', async () => {
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: async (_url, options) => {
    calls++; assert.equal(options?.redirect, 'error')
    return json({ error: 'private-upstream-url-and-secret' }, 503)
  } })
  await assert.rejects(api.state(), (error: unknown) => error instanceof HttpApiError && error.status === 503 && !error.message.includes('secret'))
  assert.equal(calls, 3)
})

test('GET retry delay and unresponsive fetch are abortable', async () => {
  const controller = new AbortController()
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: async () => { calls++; controller.abort(); return json({}, 503) } })
  await assert.rejects(api.state({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 1)
  const hanging = new HttpApi(MAINNET, { timeoutMs: 2, fetch: async () => new Promise<Response>(() => {}) })
  await assert.rejects(hanging.state(), /timed out/)
})

test('oversized, malformed JSON, wrong type and redirects fail without retry', async () => {
  for (const response of [
    new Response('x'.repeat(100), { headers: { 'content-type': 'application/json' } }),
    new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
  ]) {
    let calls = 0
    const api = new HttpApi(MAINNET, { maxResponseBytes: 64, fetch: async () => { calls++; return response } })
    await assert.rejects(api.state(), HttpApiError)
    assert.equal(calls, 1)
  }
})

test('stream byte budget works without Content-Length and stream reads time out', async () => {
  const api = new HttpApi(MAINNET, { maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(11)); controller.close()
  } }), { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(api.state(), /size limit/)
  const hung = new HttpApi(MAINNET, { timeoutMs: 2, fetch: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(hung.state(), /timed out/)
})

test('leaf pages reject gaps, oversized pages and noncanonical field values', async () => {
  const leaf = { index: 0, commitment: '1', encryptedOutput: '' }
  for (const response of [
    { total: 2, leaves: [{ ...leaf, index: 1 }] }, { total: 2, leaves: [leaf, { ...leaf, index: 1 }] },
    { total: 2, leaves: [{ ...leaf, commitment: '01' }] }, { total: 2, leaves: [{ ...leaf, commitment: FIELD_SIZE.toString() }] },
    { total: 2, leaves: [{ ...leaf, encryptedOutput: '0' }] },
  ]) {
    await assert.rejects(new HttpApi(DEVNET, { fetch: async () => json(response) }).leaves(0, 1), HttpApiError)
  }
  // The program treats note bytes as opaque; non-v1 notes must not stall the entire pool.
  assert.deepEqual((await new HttpApi(DEVNET, { fetch: async () => json({ total: 1, leaves: [leaf] }) }).leaves(0, 1)).leaves, [leaf])
})

test('nullifier pages require forward-only cursors, bounded unique canonical addresses', async () => {
  for (const value of [{ pdas: [MAINNET.relayer], next: 0 }, { pdas: [], next: 1 }, { pdas: [MAINNET.relayer, MAINNET.relayer], next: 2 }, { pdas: ['bad'], next: 1 }]) {
    await assert.rejects(new HttpApi(MAINNET, { fetch: async () => json(value) }).nullifiers(0), HttpApiError)
  }
})

test('relay preserves pending signature and strips accidental secrets from its JSON body', async () => {
  const body = Object.assign(relayBody(), { privateWitness: 'do-not-send' })
  Object.assign(body.proof, { secret: 'do-not-send' })
  let sent = ''
  const api = new HttpApi(MAINNET, { fetch: async (_url, options) => { sent = String(options?.body); return json({ signature, confirmed: false }) } })
  assert.deepEqual(await api.relay(body), { signature, confirmed: false })
  assert(!sent.includes('do-not-send'))
})

test('every failed relay HTTP exchange is unknown and POST is never retried, even HTTP 400', async () => {
  for (const status of [400, 429, 503]) {
    let calls = 0
    const api = new HttpApi(MAINNET, { fetch: async () => { calls++; return json({ error: 'secret' }, status) } })
    await assert.rejects(api.relay(relayBody()), (error: unknown) => error instanceof RelaySubmissionUnknownError && error.status === status && !error.message.includes('secret'))
    assert.equal(calls, 1)
  }
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: async () => { calls++; throw new Error('rpc-key=secret') } })
  await assert.rejects(api.ingest(signature), HttpApiError)
  assert.equal(calls, 1)
})

test('invalid local relay bindings fail before I/O; malformed relay response stays unknown', async () => {
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: async () => { calls++; return json({ signature: 'not-valid', confirmed: true }) } })
  for (const patch of [{ extAmount: '-18446744073709550616' }, { recipient: MAINNET.relayer }, { encryptedOutput1: '00'.repeat(74) }]) {
    await assert.rejects(api.relay({ ...relayBody(), ...patch }))
  }
  assert.equal(calls, 0)
  await assert.rejects(api.relay(relayBody()), RelaySubmissionUnknownError)
  assert.equal(calls, 1)
})
