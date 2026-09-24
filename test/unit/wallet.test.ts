import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { bytesToHex } from '@noble/hashes/utils'
import { MAINNET, getNetworkConfig, verifyRpcNetwork } from '../../src/networks.js'
import { createKeypairWallet, createUnlockMessage, deriveSpendingSecret, resolveSigningHost, signExactTransaction } from '../../src/wallet.js'

// Public deterministic fixture, never funded or used on a network.
const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7))
const wallet = createKeypairWallet(keypair)

test('wallet messages and spending keys remain byte-compatible with the deployed app', async () => {
  assert.equal(wallet.publicKey.toBase58(), 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB')
  assert.equal(createUnlockMessage(wallet.publicKey, MAINNET, 'app.zkpay.sh').length, 351)
  assert.equal(bytesToHex(await deriveSpendingSecret(wallet, MAINNET, 'app.zkpay.sh')),
    '00e22ed8e9cb5e086f41350ccc9c9deef924490ab8faa96de72bd4088fb5f8d9')
})

test('network, signing domain and wallet changes cannot share a spending identity', async () => {
  const mainnet = await deriveSpendingSecret(wallet, MAINNET, 'app.zkpay.sh')
  assert.notDeepEqual(mainnet, await deriveSpendingSecret(wallet, MAINNET, 'localhost:5173'))
  await assert.rejects(deriveSpendingSecret({ ...wallet, async signMessage() { return new Uint8Array(64) } }, MAINNET), /invalid unlock signature/)
  for (const host of ['https://app.zkpay.sh', 'app.zkpay.sh/path', 'user@app.zkpay.sh', 'app.zkpay.sh#fragment', 'App.zkpay.sh']) {
    assert.throws(() => resolveSigningHost(host), /host/)
  }
})

test('network endpoints are explicit and pinned; RPC must report the selected cluster', async () => {
  assert.equal(getNetworkConfig('mainnet-beta').programId, MAINNET.programId)
  assert.throws(() => getNetworkConfig('mainnet' as 'mainnet-beta'), /explicitly/)
  assert.throws(() => getNetworkConfig('mainnet-beta', { apiUrl: 'http://example.com/api' }), /HTTPS/)
  assert.throws(() => getNetworkConfig('mainnet-beta', { apiUrl: 'https://user:secret@example.com/api' }), /credentials/)
  assert.equal(getNetworkConfig('mainnet-beta', { apiUrl: 'http://localhost:8000/api/' }).apiUrl, 'http://localhost:8000/api')
  await assert.rejects(verifyRpcNetwork({ async getGenesisHash() { return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' } }, MAINNET), /cluster/)
  await verifyRpcNetwork({ async getGenesisHash() { return MAINNET.genesisHash } }, MAINNET)
})

function transaction() {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: SystemProgram.programId, lamports: 1 })],
  }).compileToV0Message())
}

test('signing verifies exact transaction bytes and a real signature', async () => {
  const original = transaction()
  const signed = await signExactTransaction(wallet, original)
  assert.ok(signed.signatures[0]!.some(byte => byte !== 0))
  assert.ok(original.signatures[0]!.every(byte => byte === 0))
  await assert.rejects(signExactTransaction({ ...wallet, async signTransaction(tx) { return tx } }, original), /invalid signature/)
  await assert.rejects(signExactTransaction({ ...wallet, async signTransaction(tx) {
    tx.message.recentBlockhash = keypair.publicKey.toBase58()
    tx.sign([keypair])
    return tx
  } }, original), /changed the prepared transaction/)
})
