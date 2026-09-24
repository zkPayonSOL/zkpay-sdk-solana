import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { encryptedNoteBytes, extDataHashField, validateExternalAmounts, vector } from './ext-data.js';
import { validateSerializedProof, type SerializedProof } from './proof.js';
import { field, FIELD_SIZE, fromBytes, publicKey, toBytes } from './validation.js';

export function getProgramAccounts(programId: PublicKey): {
  treeAccount: PublicKey; treeTokenAccount: PublicKey; globalConfig: PublicKey;
} {
  publicKey(programId, 'programId');
  const pda = (seed: string): PublicKey => PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
  return { treeAccount: pda('merkle_tree'), treeTokenAccount: pda('tree_token'), globalConfig: pda('global_config') };
}

export function nullifierPdaFor(programId: PublicKey, nullifierDecimal: string): PublicKey {
  publicKey(programId, 'programId');
  return PublicKey.findProgramAddressSync([
    Buffer.from('nullifier'), Buffer.from(toBytes(field(nullifierDecimal, 'nullifier'), 32)),
  ], programId)[0];
}

export interface TransactInstructionOptions {
  programId: PublicKey;
  proof: SerializedProof;
  extAmount: bigint;
  fee: bigint;
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  recipient: PublicKey;
  feeRecipient: PublicKey;
  signer: PublicKey;
}

export function buildTransactIx(opts: TransactInstructionOptions): TransactionInstruction {
  validateSerializedProof(opts.proof);
  validateExternalAmounts(opts.extAmount, opts.fee);
  encryptedNoteBytes(opts.encryptedOutput1);
  encryptedNoteBytes(opts.encryptedOutput2);
  publicKey(opts.recipient, 'recipient');
  publicKey(opts.feeRecipient, 'feeRecipient');
  publicKey(opts.signer, 'signer');
  const publicAmount = (opts.extAmount - opts.fee + FIELD_SIZE) % FIELD_SIZE;
  if (fromBytes(Uint8Array.from(opts.proof.publicAmount)) !== publicAmount ||
      fromBytes(Uint8Array.from(opts.proof.extDataHash)).toString() !== extDataHashField(opts)) {
    throw new Error('instruction external data does not match the proof public signals');
  }
  const { treeAccount, treeTokenAccount, globalConfig } = getProgramAccounts(opts.programId);
  const nullifiers = opts.proof.inputNullifiers.map(value => PublicKey.findProgramAddressSync([
    Buffer.from('nullifier'), Buffer.from(value),
  ], opts.programId)[0]);
  return new TransactionInstruction({
    programId: opts.programId,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: nullifiers[0]!, isSigner: false, isWritable: true },
      { pubkey: nullifiers[1]!, isSigner: false, isWritable: true },
      { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: opts.recipient, isSigner: false, isWritable: true },
      { pubkey: opts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: opts.signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([217, 149, 130, 143, 221, 52, 252, 119]),
      Buffer.from(opts.proof.proofA), Buffer.from(opts.proof.proofB), Buffer.from(opts.proof.proofC),
      Buffer.from(opts.proof.root), Buffer.from(opts.proof.publicAmount), Buffer.from(opts.proof.extDataHash),
      ...opts.proof.inputNullifiers.map(value => Buffer.from(value)),
      ...opts.proof.outputCommitments.map(value => Buffer.from(value)),
      Buffer.from(toBytes(BigInt.asUintN(64, opts.extAmount), 8, true)), Buffer.from(toBytes(opts.fee, 8, true)),
      vector(opts.encryptedOutput1), vector(opts.encryptedOutput2),
    ]),
  });
}
