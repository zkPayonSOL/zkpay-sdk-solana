import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BN254_BASE_FIELD, serializeGroth16Proof, createPoseidonHasher, createDefaultHasher, createProver } from '../../src/proving/index.js';
import { FIELD_SIZE, fromBytes } from '../../src/protocol/validation.js';
import { depositWitness, signalsOf } from './fixtures.js';

// Encoding fixture only: these coordinates deliberately are not a cryptographic proof.
const proof = { protocol: 'groth16', curve: 'bn128', pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] };

test('proof serialization encodes all limbs in Solana G1/G2 order and binds all 7 signals', () => {
  const input = depositWitness();
  const result = serializeGroth16Proof(proof, signalsOf(input), input);
  const limbs = (bytes: number[]) => Array.from({ length: bytes.length / 32 }, (_, i) => fromBytes(Uint8Array.from(bytes.slice(i * 32, (i + 1) * 32))));
  assert.deepEqual(limbs(result.proofA), [1n, 2n]);
  assert.deepEqual(limbs(result.proofB), [4n, 3n, 6n, 5n]);
  assert.deepEqual(limbs(result.proofC), [7n, 8n]);
  for (let i = 0; i < 7; i++) {
    const signals = signalsOf(input);
    signals[i] = '12345';
    assert.throws(() => serializeGroth16Proof(proof, signals, input), /mismatched/);
  }
});

test('proof serialization rejects wrong counts, coordinate ranges, protocol, and non-affine points', () => {
  const input = depositWitness();
  const signals = signalsOf(input);
  assert.throws(() => serializeGroth16Proof(proof, signals.slice(1), input), /shape/);
  assert.throws(() => serializeGroth16Proof({ ...proof, pi_a: [BN254_BASE_FIELD.toString(), '2', '1'] }, signals, input), /out-of-range/);
  assert.throws(() => serializeGroth16Proof({ ...proof, pi_a: ['01', '2', '1'] }, signals, input), /noncanonical/);
  assert.throws(() => serializeGroth16Proof({ ...proof, pi_c: ['1', '2', '0'] }, signals, input), /non-affine/);
  assert.throws(() => serializeGroth16Proof({ ...proof, protocol: 'plonk' }, signals, input), /unsupported/);
  signals[0] = FIELD_SIZE.toString();
  assert.throws(() => serializeGroth16Proof(proof, signals, input), /out-of-range/);
});

test('private input validation fails without fetching and does not include secret values', async () => {
  const secret = 'WITNESS_SECRET_NEVER_LOG';
  const input = depositWitness();
  input.inPrivateKey[0] = secret;
  let calls = 0;
  const prover = createProver({ fetch: async () => { calls++; throw new Error(); } });
  await assert.rejects(prover.prove(input), error => {
    assert.equal((error as Error).message, 'Invalid private circuit input');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

test('explicit hasher adapter validates input and output field ranges', async () => {
  const hasher = await createDefaultHasher({ initialize: async () => ({ poseidonHashString: values => values[0]! }) });
  assert.equal(hasher([123n]), 123n);
  assert.throws(() => hasher([-1n]), /inputs/);
  assert.throws(() => hasher([FIELD_SIZE]), /inputs/);
  assert.throws(() => createPoseidonHasher({ poseidonHashString: () => FIELD_SIZE.toString() })([1n]), /invalid field/);
});
