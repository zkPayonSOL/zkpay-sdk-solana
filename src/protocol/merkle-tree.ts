import { field, hash, leafIndex, MAX_LEAVES, MERKLE_TREE_DEPTH, type PoseidonHasher } from './validation.js';

/** The fixed-depth append-only Poseidon tree used by the deployed SOL circuit. */
export class MerkleTree {
  #hasher: PoseidonHasher;
  #zeros: string[] = ['0'];
  #layers: string[][] = Array.from({ length: MERKLE_TREE_DEPTH + 1 }, () => []);

  constructor(hasher: PoseidonHasher, leaves: readonly string[] = []) {
    if (typeof hasher !== 'function') throw new TypeError('Poseidon hasher is required');
    if (!Array.isArray(leaves) || leaves.length > MAX_LEAVES) throw new RangeError('invalid Merkle leaf array');
    this.#hasher = hasher;
    for (let level = 1; level <= MERKLE_TREE_DEPTH; level++) {
      const previous = BigInt(this.#zeros[level - 1]!);
      this.#zeros.push(hash(hasher, [previous, previous]).toString());
    }
    this.#layers[0] = leaves.map(value => field(value, 'commitment').toString());
    for (let level = 1; level <= MERKLE_TREE_DEPTH; level++) {
      const below = this.#layers[level - 1]!;
      const current = this.#layers[level]!;
      for (let index = 0; index < below.length; index += 2) {
        current.push(hash(hasher, [BigInt(below[index]!), BigInt(below[index + 1] ?? this.#zeros[level - 1]!)]).toString());
      }
    }
  }

  get size(): number { return this.#layers[0]!.length; }
  root(): string { return this.#layers[MERKLE_TREE_DEPTH]![0] ?? this.#zeros[MERKLE_TREE_DEPTH]!; }

  append(commitment: string): void {
    field(commitment, 'commitment');
    if (this.size >= MAX_LEAVES) throw new RangeError('Merkle tree is full');
    let index = this.size;
    this.#layers[0]!.push(commitment);
    for (let level = 1; level <= MERKLE_TREE_DEPTH; level++) {
      const below = this.#layers[level - 1]!;
      const parent = Math.floor(index / 2);
      this.#layers[level]![parent] = hash(this.#hasher, [
        BigInt(below[parent * 2]!), BigInt(below[parent * 2 + 1] ?? this.#zeros[level - 1]!),
      ]).toString();
      index = parent;
    }
  }

  indexOf(commitment: string): number {
    field(commitment, 'commitment');
    return this.#layers[0]!.indexOf(commitment);
  }

  path(index: number): { pathElements: string[]; pathIndices: number } {
    leafIndex(index);
    if (index >= this.size) throw new RangeError(`leaf index ${index} is outside this Merkle tree`);
    const pathElements: string[] = [];
    let current = index;
    for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
      pathElements.push(this.#layers[level]![current ^ 1] ?? this.#zeros[level]!);
      current = Math.floor(current / 2);
    }
    return { pathElements, pathIndices: index };
  }
}
