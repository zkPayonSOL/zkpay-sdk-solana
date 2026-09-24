import type { PublicKey } from '@solana/web3.js';
import type { ZkPayClient, PreparedDeposit, PreparedWithdrawal } from '../src/client.js';

/** Native SOL Mainnet proof + unsigned deposit transaction. This function cannot submit it. */
export async function prepareDepositForReview(client: ZkPayClient, lamports: bigint): Promise<PreparedDeposit> {
  await client.unlock();
  return client.prepareDeposit({ lamports, priorityFeeMicroLamports: 1_000 });
}

/** Gross includes the fee. This creates a local proof and review quote but never calls the relayer. */
export async function prepareWithdrawalForReview(
  client: ZkPayClient,
  grossLamports: bigint,
  recipient: PublicKey | string,
): Promise<PreparedWithdrawal> {
  await client.unlock();
  return client.prepareWithdrawal({ lamports: grossLamports, recipient });
}

// Keep the returned object with this same live client. Do not serialize it for later submission.
// An application must explicitly review, persist the intent, and choose a submit method separately.
