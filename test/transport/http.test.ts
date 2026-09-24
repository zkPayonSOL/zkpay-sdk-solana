import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { HttpApi, HttpApiError, RelaySubmissionUnknownError, type RelayRequest } from '../../src/transport.js'
import { MAINNET, type NetworkConfig } from '../../src/networks.js'
import { FIELD_SIZE, toBytes } from '../../src/protocol/validation.js'
import { extDataHashField } from '../../src/protocol/ext-data.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function state(config: NetworkConfig = MAINNET) {
  return { network: config.network, genesisHash: config.genesisHash, programId: config.programId, relayer: config.relayer,
    root: '1', leafCount: 2, chainLeaves: 2, indexedLeaves: 2, feeModel: 'gross-percentage-plus-fixed-v1',
    withdrawFeeBps: 20, baseFeeLamports: 6_000_000, shutdownAt: null, rpcUrl: '/api/mainnet/rpc', relayerEnabled: true, faucetEnabled: false }
}
// Non-state response fixtures still pass the public Mainnet identity gate.
const withMainnetState = (target: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
  if (new URL(String(input)).pathname === '/api/mainnet/state') {
    assert.equal(init?.method, 'GET')
    return json(state())
  }
  return target(input, init)
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

test('state checks the fixed Mainnet pool identity and live fee policy without replacing RPC', async () => {
  const info = await new HttpApi(MAINNET, { fetch: async url => {
    assert.equal(String(url), `${MAINNET.apiUrl}/state`)
    return json(state())
  } }).state()
  assert.equal(info.feePolicy.basisPoints, 20)
  assert.equal(info.feePolicy.baseLamports, 6_000_000n)
  assert.equal(info.rpcUrl, '/api/mainnet/rpc')
  for (const patch of [{ programId: '79EUG9jBTvcLenrTTYaHBzX6dqM9osaUXhLs3hVf4vBk' }, { relayer: MAINNET.programId }, { feeModel: 'legacy' }, { baseFeeLamports: 0 }, { withdrawFeeBps: 101 }]) {
    await assert.rejects(new HttpApi(MAINNET, { fetch: async () => json({ ...state(), ...patch }) }).state(), HttpApiError)
  }
  for (const patch of [{ network: undefined }, { network: 'devnet' }, { genesisHash: undefined }, { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }, { faucetEnabled: true }]) {
    await assert.rejects(new HttpApi(MAINNET, { fetch: async () => json({ ...state(), ...patch }) }).state(), /Mainnet/)
  }
})

test('unsupported network and mismatched Mainnet configuration are rejected before HTTP', () => {
  let calls = 0
  for (const patch of [{ network: 'devnet' }, { walletChain: 'solana:devnet' },
    { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
    { programId: '79EUG9jBTvcLenrTTYaHBzX6dqM9osaUXhLs3hVf4vBk' }]) {
    assert.throws(() => new HttpApi({ ...MAINNET, ...patch } as unknown as NetworkConfig, {
      fetch: async () => { calls++; return json(state()) },
    }), /Mainnet/)
  }
  assert.equal(calls, 0)
})

test('raw transport blocks every public operation when a custom endpoint advertises Devnet', async () => {
  const legacyEndpoint = { ...MAINNET, apiUrl: 'https://indexer.example/api' }
  for (const invoke of [
    (api: HttpApi) => api.leaves(0, 1), (api: HttpApi) => api.nullifiers(0),
    (api: HttpApi) => api.ingest(signature), (api: HttpApi) => api.relay(relayBody()),
  ]) {
    const calls: string[] = []
    const api = new HttpApi(legacyEndpoint, { fetch: async (input, init) => {
      calls.push(String(input))
      assert.equal(init?.method, 'GET', 'Wrong identity must fail before any POST')
      assert.equal(String(input), `${legacyEndpoint.apiUrl}/state`)
      return json({ ...state(), network: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' })
    } })
    await assert.rejects(invoke(api), (error: unknown) => error instanceof HttpApiError &&
      !(error instanceof RelaySubmissionUnknownError) && /Mainnet/.test(error.message))
    assert.deepEqual(calls, [`${legacyEndpoint.apiUrl}/state`])
  }
})

test('successful explicit state validation is reused for later public operations', async () => {
  const paths: string[] = []
  const api = new HttpApi(MAINNET, { fetch: async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    switch (path) {
      case '/api/mainnet/state': return json(state())
      case '/api/mainnet/leaves': return json({ total: 0, leaves: [] })
      case '/api/mainnet/nullifiers': return json({ next: 0, pdas: [] })
      case '/api/mainnet/ingest': return json({ contiguous: 0 })
      case '/api/mainnet/relay': return json({ signature, confirmed: false })
      default: throw new Error('Unexpected offline request')
    }
  } })
  await api.state()
  await api.leaves(0, 1)
  await api.nullifiers(0)
  await api.ingest(signature)
  await api.relay(relayBody())
  assert.deepEqual(paths, ['state', 'leaves', 'nullifiers', 'ingest', 'relay'].map(path => `/api/mainnet/${path}`))
})

test('a later failed explicit state check clears identity approval and prevents relay POST', async () => {
  let wrongNetwork = false
  const calls: string[] = []
  const api = new HttpApi(MAINNET, { fetch: async (input, init) => {
    calls.push(String(input))
    assert.equal(init?.method, 'GET', 'Failed identity revalidation must not issue a relay POST')
    assert.equal(String(input), `${MAINNET.apiUrl}/state`)
    return json({ ...state(), ...(wrongNetwork ? { network: 'devnet' } : {}) })
  } })
  await api.state()
  wrongNetwork = true
  await assert.rejects(api.state(), /Mainnet/)
  await assert.rejects(api.relay(relayBody()), (error: unknown) => error instanceof HttpApiError &&
    !(error instanceof RelaySubmissionUnknownError) && /Mainnet/.test(error.message))
  assert.deepEqual(calls, Array(3).fill(`${MAINNET.apiUrl}/state`))
})

test('only canonical HTTPS endpoints or explicit localhost HTTP are accepted', () => {
  for (const apiUrl of ['http://outside.invalid/api', 'https://name:secret@localhost/api', 'https://localhost/api?key=secret', 'https://localhost/api#fragment']) {
    assert.throws(() => new HttpApi({ ...MAINNET, apiUrl }))
  }
  assert.doesNotThrow(() => new HttpApi({ ...MAINNET, apiUrl: 'http://localhost:1234/api/mainnet' }))
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
    await assert.rejects(new HttpApi(MAINNET, { fetch: withMainnetState(async () => json(response)) }).leaves(0, 1), HttpApiError)
  }
  // The program treats note bytes as opaque; non-v1 notes must not stall the entire pool.
  assert.deepEqual((await new HttpApi(MAINNET, { fetch: withMainnetState(async () => json({ total: 1, leaves: [leaf] })) }).leaves(0, 1)).leaves, [leaf])
})

test('nullifier pages require forward-only cursors, bounded unique canonical addresses', async () => {
  for (const value of [{ pdas: [MAINNET.relayer], next: 0 }, { pdas: [], next: 1 }, { pdas: [MAINNET.relayer, MAINNET.relayer], next: 2 }, { pdas: ['bad'], next: 1 }]) {
    await assert.rejects(new HttpApi(MAINNET, { fetch: withMainnetState(async () => json(value)) }).nullifiers(0), HttpApiError)
  }
})

test('relay preserves pending signature and strips accidental secrets from its JSON body', async () => {
  const body = Object.assign(relayBody(), { privateWitness: 'do-not-send' })
  Object.assign(body.proof, { secret: 'do-not-send' })
  let sent = ''
  const api = new HttpApi(MAINNET, { fetch: withMainnetState(async (_url, options) => { sent = String(options?.body); return json({ signature, confirmed: false }) }) })
  assert.deepEqual(await api.relay(body), { signature, confirmed: false })
  assert(!sent.includes('do-not-send'))
})

test('every failed relay HTTP exchange is unknown and POST is never retried, even HTTP 400', async () => {
  for (const status of [400, 429, 503]) {
    let calls = 0
    const api = new HttpApi(MAINNET, { fetch: withMainnetState(async () => { calls++; return json({ error: 'secret' }, status) }) })
    await assert.rejects(api.relay(relayBody()), (error: unknown) => error instanceof RelaySubmissionUnknownError && error.status === status && !error.message.includes('secret'))
    assert.equal(calls, 1)
  }
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: withMainnetState(async () => { calls++; throw new Error('rpc-key=secret') }) })
  await assert.rejects(api.ingest(signature), HttpApiError)
  assert.equal(calls, 1)
})

test('invalid local relay bindings fail before I/O; malformed relay response stays unknown', async () => {
  let calls = 0
  const api = new HttpApi(MAINNET, { fetch: withMainnetState(async () => { calls++; return json({ signature: 'not-valid', confirmed: true }) }) })
  for (const patch of [{ extAmount: '-18446744073709550616' }, { recipient: MAINNET.relayer }, { encryptedOutput1: '00'.repeat(74) }]) {
    await assert.rejects(api.relay({ ...relayBody(), ...patch }))
  }
  assert.equal(calls, 0)
  await assert.rejects(api.relay(relayBody()), RelaySubmissionUnknownError)
  assert.equal(calls, 1)
})
