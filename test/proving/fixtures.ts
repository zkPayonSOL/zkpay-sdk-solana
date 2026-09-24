import type { CircuitInput } from '../../src/protocol/proof.js';
import type { PoseidonHasher } from '../../src/protocol/validation.js';
import { MERKLE_TREE_DEPTH, SOL_MINT_STR } from '../../src/protocol/validation.js';

/** Synthetic public test data. Dummy inputs model a first deposit; no wallet or funds are involved. */
export function depositWitness(hasher?: PoseidonHasher): CircuitInput {
  const input: CircuitInput = {
    root: '1', publicAmount: '1000', extDataHash: '7', mintAddress: SOL_MINT_STR,
    inputNullifier: ['3', '4'], inAmount: ['0', '0'], inPrivateKey: ['11', '12'], inBlinding: ['101', '102'],
    inPathIndices: [0, 1], inPathElements: [Array<string>(MERKLE_TREE_DEPTH).fill('0'), Array<string>(MERKLE_TREE_DEPTH).fill('0')],
    outputCommitment: ['5', '6'], outAmount: ['1000', '0'], outPubkey: ['13', '13'], outBlinding: ['201', '202'],
  };
  if (hasher) {
    const mint = BigInt(SOL_MINT_STR);
    for (let i = 0; i < 2; i++) {
      const sk = BigInt(input.inPrivateKey[i]!);
      const index = BigInt(input.inPathIndices[i]!);
      const commitment = hasher([0n, hasher([sk]), BigInt(input.inBlinding[i]!), mint]);
      input.inputNullifier[i] = hasher([commitment, index, hasher([sk, commitment, index])]).toString();
      input.outPubkey[i] = hasher([13n]).toString();
      input.outputCommitment[i] = hasher([BigInt(input.outAmount[i]!), BigInt(input.outPubkey[i]!), BigInt(input.outBlinding[i]!), mint]).toString();
    }
  }
  return input;
}

export function signalsOf(input: CircuitInput): string[] {
  return [input.root, input.publicAmount, input.extDataHash, ...input.inputNullifier, ...input.outputCommitment];
}
