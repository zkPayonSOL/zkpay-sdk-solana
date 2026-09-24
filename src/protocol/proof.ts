import { FIELD_SIZE, fromBytes } from './validation.js';

/** Private witness. A ProofProvider receives spend secrets: only use a trusted local prover. */
export interface CircuitInput {
  root: string;
  publicAmount: string;
  extDataHash: string;
  mintAddress: string;
  inputNullifier: string[];
  inAmount: string[];
  inPrivateKey: string[];
  inBlinding: string[];
  inPathIndices: number[];
  inPathElements: string[][];
  outputCommitment: string[];
  outAmount: string[];
  outPubkey: string[];
  outBlinding: string[];
}

export interface SerializedProof {
  proofA: number[];
  proofB: number[];
  proofC: number[];
  root: number[];
  publicAmount: number[];
  extDataHash: number[];
  inputNullifiers: number[][];
  outputCommitments: number[][];
}

export interface ProofProvider { prove(input: CircuitInput): Promise<SerializedProof>; }

function byteArray(value: unknown, length: number, label: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== length || [...value].some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError(`${label} must contain exactly ${length} integer bytes`);
  }
}

/** Validate serialization and canonical public fields before constructing a Solana instruction. */
export function validateSerializedProof(proof: SerializedProof): void {
  if (!proof || typeof proof !== 'object') throw new TypeError('proof is required');
  byteArray(proof.proofA, 64, 'proofA');
  byteArray(proof.proofB, 128, 'proofB');
  byteArray(proof.proofC, 64, 'proofC');
  // Groth16 curve coordinates live in BN254's base field, not its scalar field.
  const baseField = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  for (const point of [proof.proofA, proof.proofB, proof.proofC]) {
    for (let offset = 0; offset < point.length; offset += 32) {
      if (fromBytes(Uint8Array.from(point.slice(offset, offset + 32))) >= baseField) {
        throw new RangeError('proof coordinate exceeds the BN254 base field');
      }
    }
  }
  if (!Array.isArray(proof.inputNullifiers) || proof.inputNullifiers.length !== 2 ||
      !Array.isArray(proof.outputCommitments) || proof.outputCommitments.length !== 2) {
    throw new TypeError('proof must have exactly two input nullifiers and two output commitments');
  }
  const fields = [proof.root, proof.publicAmount, proof.extDataHash, ...proof.inputNullifiers, ...proof.outputCommitments];
  for (const value of fields) {
    byteArray(value, 32, 'proof public field');
    if (fromBytes(Uint8Array.from(value)) >= FIELD_SIZE) throw new RangeError('proof public field exceeds BN254 scalar field');
  }
  if (proof.inputNullifiers[0]!.every((byte, index) => byte === proof.inputNullifiers[1]![index])) {
    throw new Error('proof input nullifiers must be distinct');
  }
}

export function validateProofBinding(proof: SerializedProof, input: CircuitInput): void {
  validateSerializedProof(proof);
  const actual = [proof.root, proof.publicAmount, proof.extDataHash, ...proof.inputNullifiers, ...proof.outputCommitments];
  const expected = [input.root, input.publicAmount, input.extDataHash, ...input.inputNullifier, ...input.outputCommitment];
  actual.forEach((value, index) => {
    if (fromBytes(Uint8Array.from(value)).toString() !== expected[index]) {
      throw new Error(`prover returned mismatched public signal ${index}`);
    }
  });
}
