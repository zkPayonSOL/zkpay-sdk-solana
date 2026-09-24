import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { serialize } from 'borsh';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import nacl from 'tweetnacl';
import {
  ProtocolAccount, MerkleTree, NotesFragmentedError, FIELD_SIZE, SOL_MINT_STR,
  buildTransactIx, getProgramAccounts, nullifierPdaFor, validateSerializedProof,
  type CircuitInput, type LeafRecord, type PoseidonHasher, type ProofProvider, type SerializedProof,
} from '../../src/protocol/index.js';
import { extDataHashField, serializeExtData } from '../../src/protocol/ext-data.js';
import { MAX_I64, MAX_U64, fromBytes, toBytes } from '../../src/protocol/validation.js';

// A deterministic test hash is sufficient for data-flow tests; never use it as Poseidon in production.
const hasher: PoseidonHasher = inputs => fromBytes(sha256(Buffer.from(inputs.join(',')))) % FIELD_SIZE;
const spendSecret = toBytes(7n, 32);
const recipient = new PublicKey(new Uint8Array(32).fill(3));
const feeRecipient = new PublicKey(new Uint8Array(32).fill(4));
const programId = new PublicKey(new Uint8Array(32).fill(5));
const signer = new PublicKey(new Uint8Array(32).fill(6));

function fakeProof(input: CircuitInput): SerializedProof {
  const encode = (value: string): number[] => [...toBytes(BigInt(value), 32)];
  return {
    proofA: Array<number>(64).fill(0), proofB: Array<number>(128).fill(0), proofC: Array<number>(64).fill(0),
    root: encode(input.root), publicAmount: encode(input.publicAmount), extDataHash: encode(input.extDataHash),
    inputNullifiers: input.inputNullifier.map(encode), outputCommitments: input.outputCommitment.map(encode),
  };
}

function prover(onInput?: (input: CircuitInput) => void): ProofProvider {
  return { async prove(input) { onInput?.(input); return fakeProof(input); } };
}

// Independent deterministic legacy-v1 fixture: no real wallet or on-chain data is used.
function fixture(index: number, value: bigint, options: { mintIdx?: number; secret?: Uint8Array; blinding?: bigint; hasher?: PoseidonHasher } = {}): LeafRecord {
  const secret = options.secret ?? spendSecret;
  const blinding = options.blinding ?? BigInt(index + 1);
  const fixtureHasher = options.hasher ?? hasher;
  const spendPublic = fixtureHasher([fromBytes(secret)]);
  const commitment = fixtureHasher([value, spendPublic, blinding, BigInt(SOL_MINT_STR)]).toString();
  const viewSeed = sha256(Buffer.concat([Buffer.from('zkpay/view-key/v1'), Buffer.from(secret)]));
  const view = nacl.box.keyPair.fromSecretKey(viewSeed);
  const ephemeral = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(index + 30));
  const shared = nacl.box.before(view.publicKey, ephemeral.secretKey);
  const nonce = sha256(Buffer.concat([Buffer.from('zkpay/nonce/v1'), Buffer.from(ephemeral.publicKey)])).slice(0, 24);
  const tag = sha256(Buffer.concat([Buffer.from('zkpay/tag/v1'), Buffer.from(shared)]))[0]!;
  const plain = Buffer.concat([Buffer.from(toBytes(value, 8, true)), Buffer.from(toBytes(blinding, 16)), Buffer.from([options.mintIdx ?? 0])]);
  const encrypted = nacl.box.after(plain, nonce, shared);
  return { index, commitment, encryptedOutput: Buffer.concat([Buffer.from([1, tag]), Buffer.from(ephemeral.publicKey), Buffer.from(encrypted)]).toString('hex') };
}

function owned(values: bigint[]) {
  const account = new ProtocolAccount(spendSecret, hasher);
  const leaves = values.map((value, index) => fixture(index, value));
  const tree = new MerkleTree(hasher, leaves.map(leaf => leaf.commitment));
  return { account, leaves, tree, notes: account.scan(leaves) };
}

test('fixed depth Merkle appends match rebuilds and every path reconstructs the root', () => {
  const tree = new MerkleTree(hasher);
  const leaves: string[] = [];
  for (const value of ['1', '2', '3', '4', '5']) {
    tree.append(value);
    leaves.push(value);
    assert.equal(tree.root(), new MerkleTree(hasher, leaves).root());
  }
  assert.equal(tree.size, 5);
  assert.equal(tree.indexOf('3'), 2);
  for (let index = 0; index < leaves.length; index++) {
    const path = tree.path(index);
    assert.equal(path.pathElements.length, 26);
    assert.equal(path.pathIndices, index);
    let root = BigInt(leaves[index]!);
    let cursor = index;
    for (const sibling of path.pathElements) {
      root = hasher(cursor % 2 ? [BigInt(sibling), root] : [root, BigInt(sibling)]);
      cursor = Math.floor(cursor / 2);
    }
    assert.equal(root.toString(), tree.root());
  }
  for (const invalid of [-1, NaN, 0.5, 5, 2 ** 26]) assert.throws(() => tree.path(invalid), RangeError);
  for (const invalid of ['-1', '01', '1e3', FIELD_SIZE.toString(), ' 1']) assert.throws(() => tree.append(invalid));
  assert.throws(() => new MerkleTree(() => FIELD_SIZE), /invalid field/);
});

test('real Poseidon matches independently captured legacy public key, commitment, nullifier and roots', async () => {
  const wasm = await WasmFactory.getInstance();
  const poseidon: PoseidonHasher = inputs => BigInt(wasm.poseidonHashString(inputs.map(value => value.toString())));
  const secret = toBytes(1234567n, 32);
  assert.equal(poseidon([1234567n]).toString(), '13465331671963021030599200801159450903974656333803400444863695022710257005738');
  const leaf = fixture(17, 1000000000n, { secret, blinding: 11259375n, hasher: poseidon });
  assert.equal(leaf.commitment, '7785786205299186770511826190064268362437930888916336468237067812171426887919');
  const [note] = new ProtocolAccount(secret, poseidon).scan([leaf]);
  assert.equal(note!.nullifier, '10239751020217227666596514146297868157660345091808902608361993606085487227319');
  assert.equal(new MerkleTree(poseidon).root(), '8163447297445169709687354538480474434591144168767135863541048304198280615192');
  assert.equal(new MerkleTree(poseidon, [leaf.commitment]).root(), '11572987553368859742419930216609006388511905300013248241511659929033646219396');
});

test('account rejects invalid secrets, copies caller bytes, hides witness metadata, and disposal is terminal', () => {
  for (const invalid of [new Uint8Array(31), new Uint8Array(32), toBytes(FIELD_SIZE, 32)]) {
    assert.throws(() => new ProtocolAccount(invalid, hasher));
  }
  const source = spendSecret.slice();
  const account = new ProtocolAccount(source, hasher);
  source.fill(0);
  const [note] = account.scan([fixture(0, 42n)]);
  assert.equal(note!.amount, 42n);
  assert.equal(JSON.stringify(account), '{}');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(note))), ['amount', 'index', 'commitment', 'nullifier']);
  assert.equal(Object.isFrozen(note), true);
  account.dispose();
  account.dispose();
  assert.throws(() => account.scan([]), /disposed/);
});

test('scan authenticates version, mint, commitment, index, ciphertext, and skips zero or foreign notes', () => {
  const account = new ProtocolAccount(spendSecret, hasher);
  const valid = fixture(0, 42n);
  assert.equal(account.scan([valid]).length, 1);
  assert.equal(account.scan([fixture(0, 42n, { mintIdx: 1 })]).length, 0);
  assert.equal(account.scan([fixture(0, 0n)]).length, 0);
  assert.equal(account.scan([fixture(0, 42n, { secret: toBytes(8n, 32) })]).length, 0);
  assert.equal(account.scan([{ ...valid, commitment: '123' }]).length, 0);
  for (const encryptedOutput of ['ff', 'zz'.repeat(75), `02${valid.encryptedOutput.slice(2)}`, `${valid.encryptedOutput.slice(0, -2)}${valid.encryptedOutput.endsWith('00') ? '01' : '00'}`]) {
    assert.equal(account.scan([{ ...valid, encryptedOutput }]).length, 0);
  }
  for (const index of [-1, 1.5, NaN, 2 ** 26]) assert.throws(() => account.scan([{ ...valid, index }]));
  assert.throws(() => account.scan([valid, valid]), /duplicate leaf/);
  assert.throws(() => account.scan([{ ...valid, commitment: FIELD_SIZE.toString() }]));
});

test('deposit consumes the two largest owned notes, emits native SOL v1 outputs, and round-trips scanning', async () => {
  const { account, notes, tree } = owned([10n, 30n, 20n]);
  let captured: CircuitInput | undefined;
  const built = await account.buildDeposit({ tree, amount: 5n, notes, feeRecipient, prover: prover(input => { captured = structuredClone(input); }) });
  assert.equal(built.extAmount, 5n);
  assert.equal(built.fee, 0n);
  assert.deepEqual(captured!.inAmount, ['30', '20']);
  assert.deepEqual(captured!.outAmount, ['55', '0']);
  assert.equal(captured!.mintAddress, SOL_MINT_STR);
  assert.equal(captured!.publicAmount, '5');
  const leaves = built.outputCommitments.map((commitment, offset) => ({
    index: tree.size + offset, commitment,
    encryptedOutput: Buffer.from(offset === 0 ? built.encryptedOutput1 : built.encryptedOutput2).toString('hex'),
  }));
  const recovered = account.scan(leaves);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.amount, 55n);
  assert.equal(built.encryptedOutput1.length, 75);
});

test('fresh deposit uses two independently generated, distinct zero-value dummy inputs', async () => {
  const account = new ProtocolAccount(spendSecret, hasher);
  let captured: CircuitInput | undefined;
  await account.buildDeposit({ tree: new MerkleTree(hasher), amount: 1n, notes: [], feeRecipient, prover: prover(input => { captured = structuredClone(input); }) });
  assert.deepEqual(captured!.inAmount, ['0', '0']);
  assert.notEqual(captured!.inPrivateKey[0], captured!.inPrivateKey[1]);
  assert.notEqual(captured!.inputNullifier[0], captured!.inputNullifier[1]);
  for (const path of captured!.inPathElements) assert.deepEqual(path, Array(26).fill('0'));
});

test('withdrawal treats gross as total note debit and fee as part of gross', async () => {
  const { account, tree, notes } = owned([70n, 50n]);
  let captured: CircuitInput | undefined;
  const built = await account.buildWithdrawal({ tree, notes, gross: 100n, fee: 3n, recipient, feeRecipient, prover: prover(input => { captured = structuredClone(input); }) });
  assert.equal(built.extAmount, -97n);
  assert.equal(built.fee, 3n);
  assert.equal(captured!.publicAmount, (FIELD_SIZE - 100n).toString());
  assert.deepEqual(captured!.outAmount, ['20', '0']);
  assert.deepEqual(captured!.inPathIndices, [0, 1]);
});

test('fragmented balance is distinct from insufficient balance and never silently reduces withdrawal', async () => {
  const { account, tree, notes } = owned([40n, 40n, 40n]);
  const base = { tree, notes, fee: 1n, recipient, feeRecipient, prover: prover() };
  await assert.rejects(account.buildWithdrawal({ ...base, gross: 100n }), error => {
    assert.ok(error instanceof NotesFragmentedError);
    assert.equal(error.reachable, 80n);
    assert.equal(error.total, 120n);
    assert.doesNotMatch(error.message, /merge/i);
    return true;
  });
  await assert.rejects(account.buildWithdrawal({ ...base, gross: 130n }), /insufficient shielded balance/);
});

test('builders reject unsafe amounts, foreign/forged/duplicate notes and incorrect Merkle membership', async () => {
  const { account, tree, notes } = owned([10n]);
  const base = { tree, notes, feeRecipient, prover: prover() };
  for (const value of [0n, -1n, MAX_I64 + 1n, 1 as unknown as bigint]) {
    await assert.rejects(account.buildDeposit({ ...base, amount: value }));
  }
  for (const [gross, fee] of [[0n, 0n], [1n, 1n], [1n, -1n], [MAX_I64 + 1n, 0n]]) {
    await assert.rejects(account.buildWithdrawal({ ...base, recipient, gross: gross!, fee: fee! }));
  }
  await assert.rejects(account.buildDeposit({ ...base, amount: 1n, notes: [notes[0]!, notes[0]!] }), /duplicate/);
  await assert.rejects(account.buildDeposit({ ...base, amount: 1n, notes: [{ ...notes[0]! }] }), /must come from/);
  const foreign = new ProtocolAccount(spendSecret, hasher).scan([fixture(0, 10n)]);
  await assert.rejects(account.buildDeposit({ ...base, amount: 1n, notes: foreign }), /must come from/);
  await assert.rejects(account.buildDeposit({ ...base, amount: 1n, tree: new MerkleTree(hasher, ['123']) }), /does not match/);
  const overflowing = owned([MAX_U64]);
  await assert.rejects(overflowing.account.buildDeposit({ tree: overflowing.tree, notes: overflowing.notes, amount: 1n, feeRecipient, prover: prover() }), /consolidated output/);
});

test('Web Crypto unavailability fails closed before a prover is called', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const account = new ProtocolAccount(spendSecret, hasher);
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    await assert.rejects(account.buildDeposit({ tree: new MerkleTree(hasher), amount: 1n, notes: [], feeRecipient, prover: prover(() => assert.fail('prover should not run')) }), /getRandomValues/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('proof provider must return correctly bound canonical public signals and byte arrays', async () => {
  const account = new ProtocolAccount(spendSecret, hasher);
  const base = { tree: new MerkleTree(hasher), amount: 1n, notes: [], feeRecipient };
  await assert.rejects(account.buildDeposit({ ...base, prover: { async prove(input) { const proof = fakeProof(input); proof.root[31] = proof.root[31]! ^ 1; return proof; } } }), /mismatched public signal/);
  await assert.rejects(account.buildDeposit({ ...base, prover: { async prove(input) { const proof = fakeProof(input); proof.proofA = Array<number>(64); return proof; } } }), /integer bytes/);
  await assert.rejects(account.buildDeposit({ ...base, prover: { async prove(input) { const proof = fakeProof(input); proof.proofC[0] = 255; return proof; } } }), /base field/);
});

test('CompleteExtData bytes match independent Borsh encoding and hash uses little endian reduction', async () => {
  const account = new ProtocolAccount(spendSecret, hasher);
  const built = await account.buildDeposit({ tree: new MerkleTree(hasher), amount: 123n, notes: [], feeRecipient, prover: prover() });
  const data = { ...built, feeRecipient };
  const schema = { struct: {
    recipient: { array: { type: 'u8', len: 32 } }, extAmount: 'i64',
    encryptedOutput1: { array: { type: 'u8' } }, encryptedOutput2: { array: { type: 'u8' } },
    fee: 'u64', feeRecipient: { array: { type: 'u8', len: 32 } }, mintAddress: { array: { type: 'u8', len: 32 } },
  } };
  const reference = serialize(schema, {
    ...data, recipient: data.recipient.toBytes(), feeRecipient: feeRecipient.toBytes(), mintAddress: new PublicKey(SOL_MINT_STR).toBytes(),
  });
  assert.deepEqual(serializeExtData(data), reference);
  const expected = fromBytes(sha256(reference), true) % FIELD_SIZE;
  assert.equal(extDataHashField(data), expected.toString());
  assert.equal(fromBytes(Uint8Array.from(built.proof.extDataHash)), expected);
});

test('transact instruction preserves deployed discriminator, accounts, 662-byte layout and PDA seeds', async () => {
  const { account, tree, notes } = owned([100n]);
  const built = await account.buildWithdrawal({ tree, notes, gross: 50n, fee: 2n, recipient, feeRecipient, prover: prover() });
  const ix = buildTransactIx({ ...built, programId, feeRecipient, signer });
  assert.equal(ix.data.length, 662);
  assert.deepEqual([...ix.data.subarray(0, 8)], [217, 149, 130, 143, 221, 52, 252, 119]);
  assert.equal(ix.data.readBigInt64LE(488), -48n);
  assert.equal(ix.data.readBigUInt64LE(496), 2n);
  assert.equal(ix.data.readUInt32LE(504), 75);
  assert.equal(ix.data.readUInt32LE(583), 75);
  assert.deepEqual([...ix.data.subarray(508, 583)], [...built.encryptedOutput1]);
  assert.deepEqual(ix.keys.map(key => key.isSigner), [false, false, false, false, false, false, false, true, false]);
  assert.equal(ix.keys[8]!.pubkey.toBase58(), SystemProgram.programId.toBase58());
  const accounts = getProgramAccounts(programId);
  for (const [name, seed] of [['treeAccount', 'merkle_tree'], ['treeTokenAccount', 'tree_token'], ['globalConfig', 'global_config']] as const) {
    assert.equal(accounts[name].toBase58(), PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0].toBase58());
  }
  const nullifier = fromBytes(Uint8Array.from(built.proof.inputNullifiers[0]!)).toString();
  assert.equal(ix.keys[1]!.pubkey.toBase58(), nullifierPdaFor(programId, nullifier).toBase58());
  assert.throws(() => buildTransactIx({ ...built, programId, feeRecipient, signer, extAmount: -47n }), /does not match/);
  assert.throws(() => buildTransactIx({ ...built, programId, feeRecipient, signer, fee: -1n }));
  const malformed = structuredClone(built.proof);
  malformed.inputNullifiers[1] = [...malformed.inputNullifiers[0]!];
  assert.throws(() => validateSerializedProof(malformed), /distinct/);
});
