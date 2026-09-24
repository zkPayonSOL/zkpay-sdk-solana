import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { extDataHashField } from './ext-data.js';
import { MerkleTree } from './merkle-tree.js';
import { validateProofBinding, type CircuitInput, type ProofProvider, type SerializedProof } from './proof.js';
import {
  amount, bytes, field, FIELD_SIZE, fromBytes, hash, leafIndex, MAX_I64,
  MERKLE_TREE_DEPTH, NOTE_LEN, publicKey, randomBytes, SOL_MINT_STR, toBytes, type PoseidonHasher,
} from './validation.js';

export interface LeafRecord { index: number; commitment: string; encryptedOutput: string; }

/** Public note metadata; the corresponding witness stays inside its ProtocolAccount. */
export interface OwnedNote {
  readonly amount: bigint;
  readonly index: number;
  readonly commitment: string;
  readonly nullifier: string;
}

class PublicNote implements OwnedNote {
  constructor(
    readonly amount: bigint, readonly index: number, readonly commitment: string, readonly nullifier: string,
  ) { Object.freeze(this); }

  toJSON(): { amount: string; index: number; commitment: string; nullifier: string } {
    return { amount: this.amount.toString(), index: this.index, commitment: this.commitment, nullifier: this.nullifier };
  }
}

export interface BuiltTransaction {
  proof: SerializedProof;
  extAmount: bigint;
  fee: bigint;
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  recipient: PublicKey;
  outputCommitments: string[];
}

interface CommonBuildOptions {
  tree: MerkleTree;
  notes: readonly OwnedNote[];
  feeRecipient: PublicKey;
  prover: ProofProvider;
}
export interface DepositBuildOptions extends CommonBuildOptions { amount: bigint; }
export interface WithdrawalBuildOptions extends CommonBuildOptions { gross: bigint; fee: bigint; recipient: PublicKey; }

/** The balance is sufficient, but this deployed circuit can consume only two notes. */
export class NotesFragmentedError extends Error {
  constructor(readonly target: bigint, readonly reachable: bigint, readonly total: bigint, readonly noteCount: number) {
    super(`Shielded balance is fragmented: withdrawal needs ${target}, but the two largest notes cover ${reachable} of ${total} across ${noteCount} notes. This circuit accepts at most two inputs.`);
    this.name = 'NotesFragmentedError';
  }
}

function domainHash(domain: string, value: Uint8Array): Uint8Array {
  return sha256(Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from(value)]));
}

function nonce(ephemeralPublic: Uint8Array): Uint8Array {
  return domainHash('zkpay/nonce/v1', ephemeralPublic).slice(0, 24);
}

function tag(shared: Uint8Array): number { return domainHash('zkpay/tag/v1', shared)[0]!; }

/**
 * Native SOL note scanner and 2-in/2-out witness builder.
 * Secret bytes are copied into ECMAScript private fields; never serialized.
 */
export class ProtocolAccount {
  #secret: Uint8Array;
  #viewSecret: Uint8Array;
  #viewPublic: Uint8Array;
  #spendPublic: bigint;
  #hasher: PoseidonHasher;
  #disposed = false;
  #witnesses = new WeakMap<OwnedNote, bigint>();

  constructor(spendSecret: Uint8Array, hasher: PoseidonHasher) {
    bytes(spendSecret, 32, 'spendSecret');
    const secret = fromBytes(spendSecret);
    if (secret === 0n || secret >= FIELD_SIZE) throw new RangeError('spendSecret must be nonzero and below the BN254 scalar field');
    if (typeof hasher !== 'function') throw new TypeError('Poseidon hasher is required');
    this.#hasher = hasher;
    this.#spendPublic = hash(hasher, [secret]);
    this.#secret = Uint8Array.from(spendSecret);
    const seed = domainHash('zkpay/view-key/v1', this.#secret);
    const pair = nacl.box.keyPair.fromSecretKey(seed);
    this.#viewSecret = pair.secretKey;
    this.#viewPublic = pair.publicKey;
    seed.fill(0);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ProtocolAccount has been disposed');
  }

  #commitment(value: bigint, blinding: bigint, spendPublic = this.#spendPublic): string {
    return hash(this.#hasher, [value, spendPublic, blinding, BigInt(SOL_MINT_STR)]).toString();
  }

  #nullifier(commitment: string, index: number, secret = fromBytes(this.#secret)): string {
    const c = BigInt(commitment);
    const i = BigInt(index);
    const signature = hash(this.#hasher, [secret, c, i]);
    return hash(this.#hasher, [c, i, signature]).toString();
  }

  scan(leaves: readonly LeafRecord[]): OwnedNote[] {
    this.#assertActive();
    if (!Array.isArray(leaves)) throw new TypeError('leaves must be an array');
    const found: OwnedNote[] = [];
    const indices = new Set<number>();
    for (const leaf of leaves) {
      if (!leaf || typeof leaf !== 'object') throw new TypeError('leaf must be an object');
      leafIndex(leaf.index);
      field(leaf.commitment, 'leaf commitment');
      if (indices.has(leaf.index)) throw new Error(`duplicate leaf index ${leaf.index}`);
      indices.add(leaf.index);
      if (typeof leaf.encryptedOutput !== 'string' || !/^[0-9a-fA-F]{150}$/.test(leaf.encryptedOutput)) continue;
      const blob = Uint8Array.from(Buffer.from(leaf.encryptedOutput, 'hex'));
      if (blob.length !== NOTE_LEN || blob[0] !== 1) continue;
      const ephemeralPublic = blob.subarray(2, 34);
      const shared = nacl.box.before(ephemeralPublic, this.#viewSecret);
      try {
        if (blob[1] !== tag(shared)) continue;
        const plain = nacl.box.open.after(blob.subarray(34), nonce(ephemeralPublic), shared);
        if (!plain) continue;
        try {
          // Unknown mint indexes are not native SOL and must never be credited.
          if (plain.length !== 25 || plain[24] !== 0) continue;
          const value = fromBytes(plain.subarray(0, 8), true);
          const blinding = fromBytes(plain.subarray(8, 24));
          amount(value, 'note amount');
          const commitment = this.#commitment(value, blinding);
          if (value === 0n || commitment !== leaf.commitment) continue;
          const owned = new PublicNote(value, leaf.index, commitment, this.#nullifier(commitment, leaf.index));
          this.#witnesses.set(owned, blinding);
          found.push(owned);
        } finally { plain.fill(0); }
      } finally { shared.fill(0); }
    }
    return found;
  }

  #validateNotes(notes: readonly OwnedNote[]): void {
    if (!Array.isArray(notes)) throw new TypeError('notes must be an array');
    const indices = new Set<number>();
    const nullifiers = new Set<string>();
    for (const note of notes) {
      if (!note || typeof note !== 'object' || !this.#witnesses.has(note)) {
        throw new TypeError('Every input note must come from this ProtocolAccount.scan()');
      }
      amount(note.amount, 'note amount', undefined, true);
      leafIndex(note.index);
      field(note.commitment, 'note commitment');
      field(note.nullifier, 'note nullifier');
      if (indices.has(note.index) || nullifiers.has(note.nullifier)) throw new Error('duplicate input note');
      indices.add(note.index);
      nullifiers.add(note.nullifier);
    }
  }

  async buildDeposit(opts: DepositBuildOptions): Promise<BuiltTransaction> {
    this.#assertActive();
    amount(opts.amount, 'deposit amount', MAX_I64, true);
    this.#validateNotes(opts.notes);
    const inputs = [...opts.notes].sort((left, right) => left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : left.index - right.index).slice(0, 2);
    const outputAmount = inputs.reduce((total, note) => total + note.amount, opts.amount);
    amount(outputAmount, 'consolidated output amount');
    return this.#build({ ...opts, inputs, outputAmount, extAmount: opts.amount, fee: 0n, recipient: opts.feeRecipient });
  }

  async buildWithdrawal(opts: WithdrawalBuildOptions): Promise<BuiltTransaction> {
    this.#assertActive();
    amount(opts.gross, 'gross withdrawal', MAX_I64, true);
    amount(opts.fee, 'withdrawal fee');
    if (opts.fee >= opts.gross) throw new RangeError('withdrawal gross must exceed fee so recipient net amount is positive');
    this.#validateNotes(opts.notes);
    const sorted = [...opts.notes].sort((left, right) => left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : left.index - right.index);
    const inputs: OwnedNote[] = [];
    let reachable = 0n;
    for (const note of sorted.slice(0, 2)) {
      if (reachable >= opts.gross) break;
      inputs.push(note);
      reachable += note.amount;
    }
    if (reachable < opts.gross) {
      const total = sorted.reduce((sum, note) => sum + note.amount, 0n);
      if (total >= opts.gross) throw new NotesFragmentedError(opts.gross, reachable, total, opts.notes.length);
      throw new RangeError(`insufficient shielded balance: need ${opts.gross}, hold ${total}`);
    }
    return this.#build({ ...opts, inputs, outputAmount: reachable - opts.gross, extAmount: -(opts.gross - opts.fee) });
  }

  #encrypt(value: bigint, blinding: bigint): Uint8Array {
    const secret = randomBytes(32);
    const ephemeral = nacl.box.keyPair.fromSecretKey(secret);
    secret.fill(0);
    const shared = nacl.box.before(this.#viewPublic, ephemeral.secretKey);
    const plain = Uint8Array.from(Buffer.concat([Buffer.from(toBytes(value, 8, true)), Buffer.from(toBytes(blinding, 16)), Buffer.from([0])]));
    try {
      const encrypted = nacl.box.after(plain, nonce(ephemeral.publicKey), shared);
      return Uint8Array.from(Buffer.concat([Buffer.from([1, tag(shared)]), Buffer.from(ephemeral.publicKey), Buffer.from(encrypted)]));
    } finally {
      plain.fill(0);
      shared.fill(0);
      ephemeral.secretKey.fill(0);
    }
  }

  async #build(opts: CommonBuildOptions & {
    inputs: OwnedNote[]; outputAmount: bigint; extAmount: bigint; fee: bigint; recipient: PublicKey;
  }): Promise<BuiltTransaction> {
    if (!(opts.tree instanceof MerkleTree)) throw new TypeError('tree must be a MerkleTree');
    publicKey(opts.recipient, 'recipient');
    publicKey(opts.feeRecipient, 'feeRecipient');
    if (!opts.prover || typeof opts.prover.prove !== 'function') throw new TypeError('a trusted ProofProvider is required');
    const root = opts.tree.root();
    const inputs = opts.inputs.map(note => {
      const path = opts.tree.path(note.index);
      let reconstructed = BigInt(note.commitment);
      let index = note.index;
      for (const sibling of path.pathElements) {
        reconstructed = hash(this.#hasher, index % 2 === 0 ? [reconstructed, BigInt(sibling)] : [BigInt(sibling), reconstructed]);
        index = Math.floor(index / 2);
      }
      if (reconstructed.toString() !== root) throw new Error(`input note does not match the Merkle tree at index ${note.index}`);
      return { amount: note.amount, blinding: this.#witnesses.get(note)!, secret: fromBytes(this.#secret), nullifier: note.nullifier, path };
    });
    while (inputs.length < 2) {
      const secretBytes = randomBytes(31);
      const blindingBytes = randomBytes(16);
      const secret = fromBytes(secretBytes);
      const blinding = fromBytes(blindingBytes);
      secretBytes.fill(0);
      blindingBytes.fill(0);
      const commitment = this.#commitment(0n, blinding, hash(this.#hasher, [secret]));
      inputs.push({
        amount: 0n, blinding, secret, nullifier: this.#nullifier(commitment, 0, secret),
        path: { pathElements: Array<string>(MERKLE_TREE_DEPTH).fill('0'), pathIndices: 0 },
      });
    }
    const outputs = [opts.outputAmount, 0n].map(value => {
      amount(value, 'output note amount');
      const blindingBytes = randomBytes(16);
      const blinding = fromBytes(blindingBytes);
      blindingBytes.fill(0);
      return { amount: value, blinding, commitment: this.#commitment(value, blinding), encrypted: this.#encrypt(value, blinding) };
    });
    const extData = {
      recipient: opts.recipient, extAmount: opts.extAmount, fee: opts.fee, feeRecipient: opts.feeRecipient,
      encryptedOutput1: outputs[0]!.encrypted, encryptedOutput2: outputs[1]!.encrypted,
    };
    const input: CircuitInput = {
      root,
      publicAmount: ((opts.extAmount - opts.fee + FIELD_SIZE) % FIELD_SIZE).toString(),
      extDataHash: extDataHashField(extData), mintAddress: SOL_MINT_STR,
      inputNullifier: inputs.map(value => value.nullifier),
      inAmount: inputs.map(value => value.amount.toString()),
      inPrivateKey: inputs.map(value => value.secret.toString()),
      inBlinding: inputs.map(value => value.blinding.toString()),
      inPathIndices: inputs.map(value => value.path.pathIndices),
      inPathElements: inputs.map(value => value.path.pathElements),
      outputCommitment: outputs.map(value => value.commitment),
      outAmount: outputs.map(value => value.amount.toString()),
      outPubkey: outputs.map(() => this.#spendPublic.toString()),
      outBlinding: outputs.map(value => value.blinding.toString()),
    };
    const expected = { ...input, inputNullifier: [...input.inputNullifier], outputCommitment: [...input.outputCommitment] };
    const proof = await opts.prover.prove(input);
    this.#assertActive();
    validateProofBinding(proof, expected);
    return {
      proof: {
        proofA: [...proof.proofA], proofB: [...proof.proofB], proofC: [...proof.proofC],
        root: [...proof.root], publicAmount: [...proof.publicAmount], extDataHash: [...proof.extDataHash],
        inputNullifiers: proof.inputNullifiers.map(value => [...value]), outputCommitments: proof.outputCommitments.map(value => [...value]),
      },
      ...extData,
      outputCommitments: outputs.map(value => value.commitment),
    };
  }

  /** Wipes owned secret byte arrays. JavaScript cannot guarantee erasure of temporary or GC copies. */
  dispose(): void {
    this.#secret.fill(0);
    this.#viewSecret.fill(0);
    this.#witnesses = new WeakMap();
    this.#disposed = true;
  }
}
