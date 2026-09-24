/** This SDK supports the deployed Solana Mainnet Beta pool only. */
export type Network = 'mainnet-beta'

export interface NetworkConfig {
  readonly network: Network
  readonly programId: string
  readonly relayer: string
  readonly genesisHash: string
  readonly walletChain: 'solana:mainnet'
  /** Complete HTTP API prefix, without a trailing slash. */
  readonly apiUrl: string
  /** Optional user-supplied metadata; the SDK never provides a default RPC. */
  readonly rpcUrl?: string
}

export const MAINNET: NetworkConfig = Object.freeze({
  network: 'mainnet-beta',
  programId: '98Bj9K8iPV1JiVqBWXzY4bX4wsrm2x5DgEbiToybm9hx',
  relayer: 'EDm1Z5mo16C32io1cMF3JYL6ZE3hQKpY4Qt87AgBWk2g',
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  walletChain: 'solana:mainnet',
  apiUrl: 'https://app.zkpay.sh/api/mainnet',
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

/** Mainnet is the only supported network and must still be selected explicitly. */
export function getNetworkConfig(network: Network, overrides: { apiUrl?: string; rpcUrl?: string } = {}): NetworkConfig {
  if (network !== 'mainnet-beta') throw new TypeError('This SDK supports Mainnet only. Choose mainnet-beta explicitly.')
  return Object.freeze({
    ...MAINNET,
    apiUrl: validateEndpoint(overrides.apiUrl ?? MAINNET.apiUrl, 'api'),
    ...(overrides.rpcUrl !== undefined ? { rpcUrl: validateEndpoint(overrides.rpcUrl, 'rpc') } : {}),
  })
}

export function assertNetworkConfig(config: NetworkConfig): void {
  if (!config || config.network !== 'mainnet-beta') throw new TypeError('This SDK supports Mainnet only. Invalid network configuration.')
  for (const field of ['programId', 'relayer', 'genesisHash', 'walletChain'] as const) {
    if (config[field] !== MAINNET[field]) throw new TypeError('Network configuration does not identify the supported Mainnet zkPay pool.')
  }
  validateEndpoint(config.apiUrl, 'api')
  if (config.rpcUrl !== undefined) validateEndpoint(config.rpcUrl, 'rpc')
}

export async function verifyRpcNetwork(connection: { getGenesisHash(): Promise<string> }, config: NetworkConfig): Promise<void> {
  assertNetworkConfig(config)
  if (await connection.getGenesisHash() !== config.genesisHash) throw new Error('RPC cluster does not match the selected zkPay network.')
}
