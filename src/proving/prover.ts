import type { CircuitInput, ProofProvider, SerializedProof } from '../protocol/proof.js';
import { validateProofBinding } from '../protocol/proof.js';
import { FIELD_SIZE, MAX_LEAVES, MERKLE_TREE_DEPTH, field, toBytes } from '../protocol/validation.js';
import { downloadArtifacts, verifyArtifacts, type ArtifactBytes, type ArtifactDownloadOptions } from './artifacts.js';

// Coordinate field q differs from the circuit's scalar field r.
export const BN254_BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
type G1Point = [string, string, string];
type G2Point = [[string, string], [string, string], [string, string]];
interface Groth16Proof { protocol: 'groth16'; curve: 'bn128'; pi_a: G1Point; pi_b: G2Point; pi_c: G1Point; }

function scalar(value: unknown, max: bigint): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= max) {
    throw new Error('Prover returned a noncanonical or out-of-range field element');
  }
  return value;
}
function array(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error('Prover returned an invalid proof shape');
  return value;
}
function g1(value: unknown): G1Point {
  const point = array(value, 3).map(x => scalar(x, BN254_BASE_FIELD));
  if (point[2] !== '1') throw new Error('Prover returned a non-affine G1 point');
  return point as G1Point;
}
function g2(value: unknown): G2Point {
  const point = array(value, 3).map(x => array(x, 2).map(y => scalar(y, BN254_BASE_FIELD)));
  if (point[2]![0] !== '1' || point[2]![1] !== '0') throw new Error('Prover returned a non-affine G2 point');
  return point as G2Point;
}
function proofShape(value: unknown): Groth16Proof {
  if (!value || typeof value !== 'object') throw new Error('Prover returned no proof');
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== 'groth16' || raw.curve !== 'bn128') throw new Error('Prover returned an unsupported proof protocol');
  return { protocol: 'groth16', curve: 'bn128', pi_a: g1(raw.pi_a), pi_b: g2(raw.pi_b), pi_c: g1(raw.pi_c) };
}

/** Pure serialization with exact public-input binding. This does not by itself verify the pairing. */
export function serializeGroth16Proof(proofValue: unknown, signalsValue: unknown, input: CircuitInput): SerializedProof {
  const witness = copyInput(input);
  const proof = proofShape(proofValue);
  const signals = array(signalsValue, 7).map(value => scalar(value, FIELD_SIZE));
  const bytes = (value: string) => Array.from(toBytes(BigInt(value), 32));
  const g1Bytes = (point: G1Point) => [...bytes(point[0]), ...bytes(point[1])];
  // Solana alt_bn128 G2 encoding: x.c1, x.c0, y.c1, y.c0, each big-endian.
  const result: SerializedProof = {
    proofA: g1Bytes(proof.pi_a),
    proofB: [...bytes(proof.pi_b[0][1]), ...bytes(proof.pi_b[0][0]), ...bytes(proof.pi_b[1][1]), ...bytes(proof.pi_b[1][0])],
    proofC: g1Bytes(proof.pi_c),
    root: bytes(signals[0]!), publicAmount: bytes(signals[1]!), extDataHash: bytes(signals[2]!),
    inputNullifiers: [bytes(signals[3]!), bytes(signals[4]!)],
    outputCommitments: [bytes(signals[5]!), bytes(signals[6]!)],
  };
  validateProofBinding(result, witness);
  return result;
}

/** Copy the witness before any await, and reject malformed values without embedding secrets in errors. */
function copyInput(input: CircuitInput): CircuitInput {
  try {
    const copy = structuredClone(input);
    for (const key of ['root', 'publicAmount', 'extDataHash', 'mintAddress'] as const) field(copy[key], key);
    for (const key of ['inputNullifier', 'inAmount', 'inPrivateKey', 'inBlinding', 'outputCommitment', 'outAmount', 'outPubkey', 'outBlinding'] as const) {
      if (!Array.isArray(copy[key]) || copy[key].length !== 2) throw new Error();
      for (const value of copy[key]) field(value, key);
    }
    if (!Array.isArray(copy.inPathIndices) || copy.inPathIndices.length !== 2 ||
        copy.inPathIndices.some(value => !Number.isSafeInteger(value) || value < 0 || value >= MAX_LEAVES)) throw new Error();
    if (!Array.isArray(copy.inPathElements) || copy.inPathElements.length !== 2) throw new Error();
    for (const path of copy.inPathElements) {
      if (!Array.isArray(path) || path.length !== MERKLE_TREE_DEPTH) throw new Error();
      for (const value of path) field(value, 'path');
    }
    if (copy.inputNullifier[0] === copy.inputNullifier[1]) throw new Error();
    return copy;
  } catch { throw new Error('Invalid private circuit input'); }
}

export interface ProverOptions extends ArtifactDownloadOptions {
  /** Offline/custom-host bytes must match the same immutable protocol hashes. */
  artifacts?: ArtifactBytes;
}

/**
 * Lazy local Groth16 prover. Checks encoding and public-input binding; the Solana program verifies the proof.
 * signal cancels downloads and guards CPU work boundaries, not in-flight WASM.
 */
export function createProver(options: ProverOptions = {}): ProofProvider {
  // Verify/copy caller bytes now, so later caller mutations cannot alter the trusted cache.
  const supplied = options.artifacts ? verifyArtifacts(options.artifacts) : undefined;
  const { artifacts: _callerArtifacts, ...downloadOptions } = options;
  const signal = options.signal;
  let pendingArtifacts: Promise<ArtifactBytes> | undefined;
  const load = () => {
    pendingArtifacts ??= (supplied ? Promise.resolve(supplied) : downloadArtifacts(downloadOptions)).catch(error => {
      pendingArtifacts = undefined;
      throw error;
    });
    return pendingArtifacts;
  };
  return {
    async prove(input) {
      const witness = copyInput(input);
      signal?.throwIfAborted();
      const artifacts = await load();
      signal?.throwIfAborted();
      try {
        const { groth16 } = await import('snarkjs');
        const { proof, publicSignals } = await groth16.fullProve(
          witness, artifacts.wasm, artifacts.zkey, undefined, { singleThread: true }, { singleThread: true },
        );
        const serialized = serializeGroth16Proof(proof, publicSignals, witness);
        signal?.throwIfAborted();
        return serialized;
      } catch {
        // Third-party assertion errors can include secret witness values; never retain message/cause.
        if (signal?.aborted) throw new DOMException('Proof operation aborted', 'AbortError');
        throw new Error('Local Groth16 proof generation or validation failed');
      }
    },
  };
}
