import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, type Connection } from '@solana/web3.js'
import * as sdk from '../../src/index.js'
import { MAINNET, assertNetworkConfig, getNetworkConfig, type Network, type NetworkConfig } from '../../src/networks.js'
import { ZkPayClient } from '../../src/client.js'
import { HttpApi } from '../../src/transport.js'
import { PoolSynchronizer } from '../../src/pool.js'
import { createKeypairWallet, createUnlockMessage, deriveSpendingSecret } from '../../src/wallet.js'

// Public fixture only: no wallet files or real network requests.
const signer = createKeypairWallet(Keypair.fromSeed(new Uint8Array(32).fill(7)))
const incompatibleGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

test('the public SDK rejects every non-Mainnet selection at both type and runtime boundaries', async () => {
  assert.equal('DEVNET' in sdk, false)
  for (const network of ['devnet', 'testnet', 'localnet', 'mainnet', '', undefined]) {
    assert.throws(() => getNetworkConfig(network as Network), /Mainnet only/)
    await assert.rejects(ZkPayClient.create({ network: network as Network, wallet: signer,
      rpcUrl: 'https://rpc.example/',
      hasher: () => { throw new Error('Must reject before initializing protocol state') },
    }), /Mainnet only/)
  }
  // @ts-expect-error Devnet is not part of the exported Network type.
  const rejectedNetwork: Network = 'devnet'
  assert.throws(() => getNetworkConfig(rejectedNetwork), /Mainnet only/)
})

test('forged configurations cannot reach a wallet or start indexer/RPC access', async () => {
  let callbacks = 0
  const wallet = { ...signer, async signMessage() { callbacks++; return new Uint8Array(64) } }
  const fetcher: typeof fetch = async () => { callbacks++; throw new Error('Unexpected request') }
  for (const patch of [
    { network: 'devnet' }, { walletChain: 'solana:devnet' }, { genesisHash: incompatibleGenesis },
    { programId: '79EUG9jBTvcLenrTTYaHBzX6dqM9osaUXhLs3hVf4vBk' },
    { relayer: '3bvGP8qiJZ7CxM1JUijBReQGUUQctxefufXYBx2XUSgL' },
  ]) {
    const config = { ...MAINNET, ...patch } as NetworkConfig
    assert.throws(() => assertNetworkConfig(config), /Mainnet/)
    assert.throws(() => new HttpApi(config, { fetch: fetcher }), /Mainnet/)
    assert.throws(() => new PoolSynchronizer({ config, connection: {} as Connection,
      api: {} as HttpApi, hasher: () => 1n }), /Mainnet/)
    assert.throws(() => createUnlockMessage(wallet.publicKey, config, 'app.zkpay.sh'), /Mainnet/)
    await assert.rejects(deriveSpendingSecret(wallet, config), /Mainnet/)
  }
  assert.equal(callbacks, 0)
})

test('a custom RPC reporting Devnet cannot unlock or request any wallet signature', async () => {
  let signatures = 0
  let requests = 0
  const client = await ZkPayClient.create({
    network: 'mainnet-beta', hasher: () => 1n,
    wallet: { ...signer, async signMessage() { signatures++; return new Uint8Array(64) } },
    connection: { async getGenesisHash() { requests++; return incompatibleGenesis } } as Connection,
    fetch: async () => { throw new Error('Unexpected indexer request') },
  })
  try {
    await assert.rejects(client.unlock(), /network RPC/)
    assert.equal(client.isUnlocked, false)
    assert.equal(signatures, 0)
    assert.equal(requests, 1)
  } finally { client.dispose() }
})
