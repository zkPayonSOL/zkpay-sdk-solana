import { ZkPayClient } from '../src/client.js';
import type { Network } from '../src/networks.js';
import type { WalletSigner } from '../src/wallet.js';
import { createDefaultHasher, createProver, type LightWasmHasher } from '../src/proving/index.js';

export interface BrowserExampleOptions {
  network: Network;
  wallet: WalletSigner;
  /** Your controlled proxy/self-hosted API; official third-party CORS must not be assumed. */
  apiUrl: string;
  rpcUrl: string;
  /** Serve the exact pinned WASM, zkey, and vkey with same-origin access or suitable CORS. */
  artifactBaseUrl: string | URL;
  /** Initialize via your bundler's explicit WASM loader; no automatic WASM copy is assumed. */
  initializeWasm: () => Promise<LightWasmHasher>;
}

/** No automatic unlock or submission. Call from a browser user action, then manage its lifetime. */
export async function createBrowserExampleClient(options: BrowserExampleOptions): Promise<ZkPayClient> {
  const hasher = await createDefaultHasher({ initialize: options.initializeWasm });
  const prover = createProver({ baseUrl: options.artifactBaseUrl });
  return ZkPayClient.create({
    network: options.network,
    wallet: options.wallet,
    apiUrl: options.apiUrl,
    rpcUrl: options.rpcUrl,
    hasher,
    prover,
    // Browser signingHost deliberately omitted: it must match location.host.
  });
}
