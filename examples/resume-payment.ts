import type { ZkPayClient, PendingPayment, PaymentStatus } from '../src/client.js';

/**
 * savedPayment comes from private durable application storage, preferably saved before submission.
 * The client must use network: 'mainnet-beta' with the original wallet and signing host.
 * This helper never resubmits.
 */
export async function resumeAndCheckPayment(
  client: ZkPayClient,
  savedPayment: PendingPayment,
  signal?: AbortSignal,
): Promise<PaymentStatus> {
  client.resumePayment(savedPayment);
  const call = signal ? { signal } : {};
  await client.unlock(call);
  const status = await client.getPaymentStatus(savedPayment, call);
  // 'unknown'/'submitted' means check again later or investigate; never retry a send automatically.
  return status;
}
