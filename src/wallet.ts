import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha256'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import nacl from 'tweetnacl'
import { assertNetworkConfig, type NetworkConfig } from './networks.js'

export interface WalletSigner {
  readonly publicKey: PublicKey
  signMessage(message: Uint8Array): Promise<Uint8Array>
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>
}

function checkHost(host: string): string {
  let url: URL
  try { url = new URL(`https://${host}`) } catch { throw new TypeError('Invalid signing host.') }
  if (!host || host.length > 253 || url.host !== host || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Signing host must be an exact hostname with optional port, not a URL.')
  }
  return host
}

/** A browser may not silently ask for another application's signing domain. */
export function resolveSigningHost(requested?: string): string {
  const actual = typeof location !== 'undefined' ? location.host : undefined
  const host = checkHost(requested ?? actual ?? 'app.zkpay.sh')
  if (actual && host !== actual) throw new Error('Signing host must match this browser page. A different host controls a different private balance.')
  return host
}

/** Exact deployed message bytes. Changing any character changes existing keys. */
export function createUnlockMessage(publicKey: PublicKey, config: NetworkConfig, host: string): Uint8Array {
  assertNetworkConfig(config)
  checkHost(host)
  const address = publicKey.toBase58()
  return utf8ToBytes(config.network === 'devnet'
    ? `${host} wants you to sign in with your Solana account:\n${address}\n\n` +
      'Signing derives your private zkPay key. It authorizes no transaction and costs nothing.\n\n' +
      `Only ever sign this on ${host}. Another site asking for the same message is trying ` +
      'to reach your shielded balance.'
    : `zkPay private spend key\n\nOrigin: ${host}\nAccount: ${address}\n` +
      `Network: Solana Mainnet Beta\nProgram: ${config.programId}\n\n` +
      'Signing derives your private zkPay key. It authorizes no transaction and costs nothing.\n' +
      `Only sign this on ${host}. Never share this signature or your private key.`)
}

/**
 * Returns the 248-bit deployed spend secret padded to 32 bytes, big-endian.
 * Nothing is written to storage. The unlock signature is itself sensitive.
 */
export async function deriveSpendingSecret(wallet: WalletSigner, config: NetworkConfig, host = resolveSigningHost()): Promise<Uint8Array> {
  const key = new PublicKey(wallet.publicKey.toBytes())
  const message = createUnlockMessage(key, config, resolveSigningHost(host))
  const returned = await wallet.signMessage(message.slice())
  if (!(returned instanceof Uint8Array) || returned.length !== 64 ||
      !wallet.publicKey.equals(key) || !nacl.sign.detached.verify(message, returned, key.toBytes())) {
    throw new Error('Wallet returned an invalid unlock signature or changed accounts.')
  }
  const signature = returned.slice()
  const tag = utf8ToBytes(config.network === 'devnet' ? 'zkpay/spend/v1' : 'zkpay/spend/mainnet/v1')
  const digest = sha256(concatBytes(tag, signature))
  const secret = new Uint8Array(32)
  secret.set(digest.subarray(0, 31), 1)
  signature.fill(0)
  digest.fill(0)
  if (secret.every(byte => byte === 0)) throw new Error('Invalid zero spending key.')
  return secret
}

/** Reject changed messages, foreign accounts, missing or invalid signatures. */
export async function signExactTransaction(wallet: WalletSigner, transaction: VersionedTransaction): Promise<VersionedTransaction> {
  const key = new PublicKey(wallet.publicKey.toBytes())
  const expected = transaction.message.serialize().slice()
  if (transaction.version !== 0 || transaction.message.header.numRequiredSignatures !== 1 ||
      !transaction.message.staticAccountKeys[0]?.equals(key) || transaction.serialize().length > 1232) {
    throw new Error('Deposit must be a single-signer v0 transaction for this wallet.')
  }
  // A copy prevents an adapter from mutating the caller's prepared transaction.
  const signed = await wallet.signTransaction(VersionedTransaction.deserialize(transaction.serialize()))
  if (!(signed instanceof VersionedTransaction) || !wallet.publicKey.equals(key)) throw new Error('Wallet returned an invalid signed transaction.')
  const actual = signed.message.serialize()
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index]) || signed.signatures.length !== 1 ||
      !signed.signatures[0] || !nacl.sign.detached.verify(expected, signed.signatures[0], key.toBytes())) {
    throw new Error('Wallet changed the prepared transaction or returned an invalid signature.')
  }
  if (signed.serialize().length > 1232) throw new Error('Signed transaction exceeds the Solana packet limit.')
  // Do not retain an object still owned by the wallet adapter across later awaits.
  return VersionedTransaction.deserialize(signed.serialize())
}

/** In-memory Node/programmatic adapter. The SDK never loads a key from disk. */
export function createKeypairWallet(keypair: Keypair): WalletSigner {
  const signer = Keypair.fromSecretKey(keypair.secretKey)
  return Object.freeze({
    publicKey: signer.publicKey,
    async signMessage(message: Uint8Array) { return nacl.sign.detached(message, signer.secretKey) },
    async signTransaction(transaction: VersionedTransaction) {
      const signed = VersionedTransaction.deserialize(transaction.serialize())
      signed.sign([signer])
      return signed
    },
  })
}
