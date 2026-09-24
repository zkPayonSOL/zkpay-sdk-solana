import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSol, MAX_TRANSACTION_LAMPORTS, parseSol } from '../../src/amounts.js'
import { DEFAULT_FEE_POLICY, quoteWithdrawal } from '../../src/fees.js'

test('SOL amounts round-trip without a floating-point conversion', () => {
  for (const value of ['0', '0.000000001', '0.1', '1', '3', '5', '9007199.254740993']) {
    assert.equal(formatSol(parseSol(value)), value)
  }
  assert.equal(parseSol(formatSol(MAX_TRANSACTION_LAMPORTS)), MAX_TRANSACTION_LAMPORTS)
})

test('non-canonical or out-of-range amounts fail closed', () => {
  for (const value of ['', '-1', '+1', '1e3', '0x10', '01', '.1', '1.', ' 1', '1 ', '1.0000000001', '9223372036.854775808']) {
    assert.throws(() => parseSol(value), { name: /TypeError|RangeError/ })
  }
  assert.throws(() => parseSol(1 as unknown as string), TypeError)
})

test('withdrawal fees are charged within the gross amount', () => {
  for (const [gross, fee, net] of [
    ['1', '0.008', '0.992'], ['3', '0.012', '2.988'], ['5', '0.016', '4.984'],
  ]) {
    const quote = quoteWithdrawal(parseSol(gross!))
    assert.equal(quote.feeLamports, parseSol(fee!))
    assert.equal(quote.recipientLamports, parseSol(net!))
    assert.equal(quote.grossLamports, quote.feeLamports + quote.recipientLamports)
  }
})

test('fee policy limits and tiny payments are enforced', () => {
  assert.throws(() => quoteWithdrawal(6_000_000n), RangeError)
  assert.throws(() => quoteWithdrawal(0n), RangeError)
  for (const basisPoints of [-1, 101, 1.2, NaN, Infinity]) {
    assert.throws(() => quoteWithdrawal(parseSol('1'), { ...DEFAULT_FEE_POLICY, basisPoints }), RangeError)
  }
  assert.throws(() => quoteWithdrawal(parseSol('1'), { ...DEFAULT_FEE_POLICY, baseLamports: 0n }), RangeError)
  assert.throws(() => quoteWithdrawal(6_012_024n), RangeError)
  assert.equal(quoteWithdrawal(6_012_025n).recipientLamports, 1n)
})
