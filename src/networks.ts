export type Network = 'devnet' | 'mainnet-beta'

export interface NetworkConfig {
  readonly network: Network
  readonly programId: string
  readonly relayer: string
  readonly genesisHash: string
  readonly walletChain: 'solana:devnet' | 'solana:mainnet'
  /** Complete HTTP API prefix, without a trailing slash. */
  readonly apiUrl: string
  readonly rpcUrl: string
}

export const MAINNET: NetworkConfig = Object.freeze({
  network: 'mainnet-beta',
  programId: '98Bj9K8iPV1JiVqBWXzY4bX4wsrm2x5DgEbiToybm9hx',
  relayer: 'EDm1Z5mo16C32io1cMF3JYL6ZE3hQKpY4Qt87AgBWk2g',
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  walletChain: 'solana:mainnet',
  apiUrl: 'https://app.zkpay.sh/api/mainnet',
  rpcUrl: 'https://app.zkpay.sh/api/mainnet/rpc',
})

export const DEVNET: NetworkConfig = Object.freeze({
  network: 'devnet',
  programId: '79EUG9jBTvcLenrTTYaHBzX6dqM9osaUXhLs3hVf4vBk',
  relayer: '3bvGP8qiJZ7CxM1JUijBReQGUUQctxefufXYBx2XUSgL',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  walletChain: 'solana:devnet',
  apiUrl: 'https://app.zkpay.sh/api',
  rpcUrl: 'https://api.devnet.solana.com',
})

export function validateEndpoint(value: string, kind: 'api' | 'rpc'): string {
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError(`Invalid ${kind.toUpperCase()} URL.`) }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.hash || (kind === 'api' && url.search)) {
    throw new TypeError(`${kind.toUpperCase()} requires HTTPS, no embedded credentials or fragment; API prefixes cannot contain a query.`)
  }
  return kind === 'api' ? url.href.replace(/\/+$/, '') : url.href
}

/** The caller must choose a network explicitly; there is no implicit Mainnet. */
export function getNetworkConfig(network: Network, overrides: { apiUrl?: string; rpcUrl?: string } = {}): NetworkConfig {
  if (network !== 'devnet' && network !== 'mainnet-beta') throw new TypeError('Choose devnet or mainnet-beta explicitly.')
  const base = network === 'devnet' ? DEVNET : MAINNET
  return Object.freeze({
    ...base,
    apiUrl: validateEndpoint(overrides.apiUrl ?? base.apiUrl, 'api'),
    rpcUrl: validateEndpoint(overrides.rpcUrl ?? base.rpcUrl, 'rpc'),
  })
}

export function assertNetworkConfig(config: NetworkConfig): void {
  if (!config || (config.network !== 'devnet' && config.network !== 'mainnet-beta')) throw new TypeError('Invalid network configuration.')
  const expected = config.network === 'devnet' ? DEVNET : MAINNET
  for (const field of ['programId', 'relayer', 'genesisHash', 'walletChain'] as const) {
    if (config[field] !== expected[field]) throw new TypeError('Network configuration does not identify a supported zkPay pool.')
  }
  validateEndpoint(config.apiUrl, 'api')
  validateEndpoint(config.rpcUrl, 'rpc')
}

export async function verifyRpcNetwork(connection: { getGenesisHash(): Promise<string> }, config: NetworkConfig): Promise<void> {
  assertNetworkConfig(config)
  if (await connection.getGenesisHash() !== config.genesisHash) throw new Error('RPC cluster does not match the selected zkPay network.')
}
