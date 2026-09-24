/**
 * Explicit opt-in only: ZKPAY_LIVE_READONLY=1 npm test -- ...
 * Reads public production state; never loads wallet files, environment files,
 * credentials or funded keys, and a fetch guard rejects every write method.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha256'
import { MAINNET } from '../../src/networks.js'
import { HttpApi } from '../../src/transport.js'
import { PoolSynchronizer } from '../../src/pool.js'
import { ProtocolAccount, type PoseidonHasher } from '../../src/protocol/index.js'
import { createDefaultHasher } from '../../src/proving/hasher.js'

const enabled = process.env.ZKPAY_LIVE_READONLY === '1'
let hasherPromise: Promise<PoseidonHasher> | undefined

const config = MAINNET
test(`live readonly ${config.network}: genesis, deployed layouts, Merkle prefix and unfunded fixture`, {
  skip: !enabled,
  timeout: 60_000,
}, async context => {
  const rpcCounts = new Map<string, number>()
  let httpReads = 0
  let phase = 'local hasher initialization'
  const hasher = await (hasherPromise ??= createDefaultHasher())
  // This is a deliberately public deterministic, unfunded test identity, not
  // a Solana wallet key. Never use its known secret to receive real funds.
  const publicFixtureSecret = new Uint8Array(32)
  publicFixtureSecret.set(sha256(new TextEncoder().encode('zkpay-sdk-solana/live-readonly/public-unfunded-fixture/v1')).subarray(0, 31), 1)
  const account = new ProtocolAccount(publicFixtureSecret, hasher)
  publicFixtureSecret.fill(0)
  const readOnlyFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.href === new URL(config.rpcUrl).href) {
      assert.equal(method, 'POST', 'JSON-RPC reads use POST')
      assert.equal(typeof init?.body, 'string', 'RPC requests must be transparent JSON')
      const body = JSON.parse(init?.body as string) as { method?: unknown }
      assert.equal(typeof body.method, 'string')
      assert(['getGenesisHash', 'getMultipleAccounts'].includes(body.method as string), 'Only allowlisted read-only RPC methods are allowed')
      const rpcMethod = body.method as string
      rpcCounts.set(rpcMethod, (rpcCounts.get(rpcMethod) ?? 0) + 1)
    } else {
      assert.equal(method, 'GET', 'API POSTs are forbidden by this smoke test')
      assert.equal(url.origin, new URL(config.apiUrl).origin)
      assert([`${config.apiUrl}/state`, `${config.apiUrl}/leaves`].includes(`${url.origin}${url.pathname}`), 'Only state and public leaf reads are allowed')
      httpReads++
    }
    const signals = [context.signal, AbortSignal.timeout(15_000)]
    if (init?.signal) signals.push(init.signal)
    return globalThis.fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
  }
  const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: readOnlyFetch })
  const api = new HttpApi(config, { fetch: readOnlyFetch, timeoutMs: 15_000 })
  try {
    phase = 'RPC genesis'
    assert.equal(await connection.getGenesisHash(), config.genesisHash)
    phase = 'public API state'
    const advertised = await api.state({ signal: context.signal })
    assert.equal(advertised.programId, config.programId)
    assert.equal(advertised.relayer, config.relayer)
    context.diagnostic(`${config.network}: genesis and API identity verified; chainLeaves=${advertised.chainLeaves}, indexedLeaves=${advertised.indexedLeaves}, feeBps=${advertised.feePolicy.basisPoints}`)
    phase = 'chain layouts and verified Merkle synchronization'
    // These conservative smoke limits deliberately fail instead of launching
    // a production-wide history crawl as a test network grows.
    const sync = new PoolSynchronizer({ config, connection, api, hasher, maxLeaves: 20_000, maxPages: 10, rpcTimeoutMs: 15_000 })
    const snapshot = await sync.sync(account, { signal: context.signal })
    assert.equal(snapshot.state.genesisHash, config.genesisHash)
    assert.equal(snapshot.tree.root(), snapshot.state.root)
    assert.equal(snapshot.tree.size, snapshot.state.leafCount)
    assert(snapshot.state.recentRoots.includes(snapshot.state.root))
    assert.equal(snapshot.balanceLamports, 0n, 'The public dummy identity must remain unfunded')
    assert.equal(snapshot.spendableLamports, 0n)
    assert.equal(snapshot.notes.length, 0)
    context.diagnostic(`${config.network}: verified ${snapshot.state.leafCount} leaves, ${snapshot.state.recentRoots.length} populated root-history entries, zero fixture notes; HTTP reads=${httpReads}, RPC reads=${JSON.stringify(Object.fromEntries(rpcCounts))}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : 'Unknown read failure'
    context.diagnostic(`${config.network}: stopped during ${phase}; ${detail}; no write request was made`)
    throw error
  } finally { account.dispose() }
})
