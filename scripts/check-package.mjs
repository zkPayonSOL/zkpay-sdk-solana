import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.private, true, 'Publication must remain an explicit owner decision.')
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
assert.ok(packed.files.some(file => file.path === 'dist/index.js'))
assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'))
for (const file of packed.files) {
  assert.match(file.path, /^(dist\/|README\.md$|SECURITY\.md$|CHANGELOG\.md$|package\.json$)/)
  assert.doesNotMatch(file.path, /(?:\.env|\.sk$|keypair\.json|\.pem$|node_modules|\.artifacts|\.tgz$)/)
  const content = await readFile(new URL(`../${file.path}`, import.meta.url), 'utf8')
  assert.ok(!/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(content), `Credential-like content in ${file.path}`)
}

// Root import must not start requests or background polling, including lazy dependencies.
const originalFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('Unexpected network access on import.') }
try {
  const sdk = await import('../dist/index.js')
  assert.equal(sdk.parseSol('1.000000001'), 1_000_000_001n)
  assert.equal(typeof sdk.ZkPayClient.create, 'function')
  assert.equal(typeof sdk.createProver, 'function')
  assert.equal('DEVNET' in sdk, false)
  assert.equal(sdk.getNetworkConfig('mainnet-beta').network, 'mainnet-beta')
  assert.equal(Object.hasOwn(sdk.MAINNET, 'rpcUrl'), false)
  assert.equal(Object.hasOwn(sdk.getNetworkConfig('mainnet-beta'), 'rpcUrl'), false)
  assert.throws(() => sdk.getNetworkConfig('devnet'), /Mainnet only/)
} finally { globalThis.fetch = originalFetch }

// No Node built-in fallbacks or ambient Buffer/process are supplied to this browser bundle.
const result = await build({
  entryPoints: ['dist/index.js'], bundle: true, platform: 'browser', target: 'es2022',
  format: 'iife', globalName: 'ZkPaySDK', write: false, logLevel: 'silent',
})
const sandbox = createContext({
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, AbortController, AbortSignal,
  Uint8Array, ArrayBuffer, DataView, fetch: () => { throw new Error('Unexpected browser import request.') },
  setTimeout: () => { throw new Error('Unexpected browser import timer.') }, clearTimeout: () => {},
})
runInContext(result.outputFiles[0].text, sandbox, { timeout: 10_000 })
assert.equal(runInContext('ZkPaySDK.parseSol("0.1")', sandbox), 100_000_000n)
assert.equal(runInContext('typeof ZkPaySDK.ZkPayClient.create', sandbox), 'function')
assert.equal(runInContext('"DEVNET" in ZkPaySDK', sandbox), false)
assert.equal(runInContext('Object.hasOwn(ZkPaySDK.MAINNET, "rpcUrl")', sandbox), false)
assert.throws(() => runInContext('ZkPaySDK.getNetworkConfig("devnet")', sandbox), /Mainnet only/)
console.log(`Package allowlist, credential scan, Node import, and browser bundle smoke passed (${packed.files.length} files).`)
