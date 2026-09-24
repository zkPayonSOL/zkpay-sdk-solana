import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';
import { amount, bytes, FIELD_SIZE, fromBytes, MAX_I64, NOTE_LEN, publicKey, SOL_MINT_STR, toBytes } from './validation.js';

export interface ExtData {
  recipient: PublicKey;
  extAmount: bigint;
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  fee: bigint;
  feeRecipient: PublicKey;
}

export function validateExternalAmounts(extAmount: bigint, fee: bigint): void {
  if (typeof extAmount !== 'bigint' || extAmount === 0n || extAmount < -MAX_I64 || extAmount > MAX_I64) {
    throw new RangeError('extAmount must be a nonzero bigint in the supported signed i64 range');
  }
  amount(fee, 'fee');
  if (extAmount > 0n && fee !== 0n) throw new RangeError('native SOL deposits must have zero fee');
  if (extAmount < 0n && -extAmount + fee > MAX_I64) throw new RangeError('gross withdrawal exceeds the supported i64 range');
}

export function encryptedNoteBytes(value: Uint8Array): void {
  bytes(value, NOTE_LEN, 'encrypted note');
  if (value[0] !== 1) throw new RangeError('encrypted note must use version 1');
}

export function vector(value: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(toBytes(BigInt(value.length), 4, true)), Buffer.from(value)]);
}

/** Borsh-compatible CompleteExtData, matching the deployed native SOL program. */
export function serializeExtData(value: ExtData): Uint8Array {
  validateExternalAmounts(value.extAmount, value.fee);
  encryptedNoteBytes(value.encryptedOutput1);
  encryptedNoteBytes(value.encryptedOutput2);
  publicKey(value.recipient, 'recipient');
  publicKey(value.feeRecipient, 'feeRecipient');
  return Uint8Array.from(Buffer.concat([
    value.recipient.toBuffer(),
    Buffer.from(toBytes(BigInt.asUintN(64, value.extAmount), 8, true)),
    vector(value.encryptedOutput1), vector(value.encryptedOutput2),
    Buffer.from(toBytes(value.fee, 8, true)),
    value.feeRecipient.toBuffer(), new PublicKey(SOL_MINT_STR).toBuffer(),
  ]));
}

export function extDataHashField(value: ExtData): string {
  // Rust compares Fr::from_le_bytes_mod_order(SHA256(borsh(extData))).
  return (fromBytes(sha256(serializeExtData(value)), true) % FIELD_SIZE).toString();
}
