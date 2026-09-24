import { ZkPayClient, type ClientOptions, type PrivateBalance } from '../src/client.js';

/**
 * Called explicitly by the application. The caller supplies the wallet, network: 'mainnet-beta',
 * and exactly one rpcUrl or Connection. A public RPC is allowed only as an explicit caller choice.
 * No private key is loaded from disk/environment. This requests an unlock signature and reads state;
 * it never signs a transaction or broadcasts. Keep returned balances out of public logs.
 */
export async function readPrivateBalance(
  options: ClientOptions,
  signal?: AbortSignal,
): Promise<PrivateBalance> {
  const client = await ZkPayClient.create(options);
  const call = signal ? { signal } : {};
  try {
    await client.unlock(call);
    return await client.getPrivateBalance(call);
  } finally {
    client.dispose();
  }
}
