import { assertLamports } from './amounts.js'

export const WITHDRAWAL_FEE_MODEL = 'gross-percentage-plus-fixed-v1' as const
export interface FeePolicy {
  readonly model: typeof WITHDRAWAL_FEE_MODEL
  readonly basisPoints: number
  readonly baseLamports: bigint
}
export const DEFAULT_FEE_POLICY: FeePolicy = Object.freeze({
  model: WITHDRAWAL_FEE_MODEL,
  basisPoints: 20,
  baseLamports: 6_000_000n,
})
export interface WithdrawalQuote {
  readonly grossLamports: bigint
  readonly feeLamports: bigint
  readonly recipientLamports: bigint
  readonly policy: FeePolicy
}

export function validateFeePolicy(policy: FeePolicy): void {
  if (!policy || policy.model !== WITHDRAWAL_FEE_MODEL ||
      !Number.isInteger(policy.basisPoints) || policy.basisPoints < 0 || policy.basisPoints > 100 ||
      policy.baseLamports !== 6_000_000n) {
    throw new RangeError('Unsupported zkPay withdrawal fee policy.')
  }
}

/** Gross is the total private-balance debit, not the recipient's net amount. */
export function quoteWithdrawal(grossLamports: bigint, policy: FeePolicy = DEFAULT_FEE_POLICY): WithdrawalQuote {
  assertLamports(grossLamports)
  validateFeePolicy(policy)
  const feeLamports = grossLamports * BigInt(policy.basisPoints) / 10_000n + policy.baseLamports
  if (grossLamports <= feeLamports) throw new RangeError('Withdrawal amount must exceed its fee.')
  return Object.freeze({ grossLamports, feeLamports, recipientLamports: grossLamports - feeLamports, policy: Object.freeze({ ...policy }) })
}
