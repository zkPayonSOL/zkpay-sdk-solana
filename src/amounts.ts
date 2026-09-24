/** Amounts are always integer lamports; never pass floating-point SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000n
export const MAX_TRANSACTION_LAMPORTS = (1n << 63n) - 1n

export function assertLamports(amount: bigint, options: { allowZero?: boolean } = {}): void {
  if (typeof amount !== 'bigint' || amount < (options.allowZero ? 0n : 1n) || amount > MAX_TRANSACTION_LAMPORTS) {
    throw new RangeError('Amount must be integer lamports within the positive signed 64-bit range.')
  }
}

/** Exact SOL decimal parsing. Exponents, signs and excess precision are rejected. */
export function parseSol(value: string): bigint {
  if (typeof value !== 'string' || value.length > 32 || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    throw new TypeError('SOL must be a canonical decimal string with at most nine fractional digits.')
  }
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole!) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0'))
  assertLamports(amount, { allowZero: true })
  return amount
}

export function formatSol(amount: bigint): string {
  assertLamports(amount, { allowZero: true })
  const whole = amount / LAMPORTS_PER_SOL
  const fraction = (amount % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
