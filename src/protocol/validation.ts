import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const MERKLE_TREE_DEPTH = 26;
export const MAX_LEAVES = 2 ** MERKLE_TREE_DEPTH;
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_I64 = (1n << 63n) - 1n;
export const SOL_MINT_STR = '11111111111111111111111111111112';
export const NOTE_LEN = 75;
export type PoseidonHasher = (inputs: readonly bigint[]) => bigint;

export function field(value: string, label: string): bigint {
  if (typeof value !== 'string' || value.length > 77 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal field element`);
  }
  const parsed = BigInt(value);
  if (parsed >= FIELD_SIZE) throw new RangeError(`${label} exceeds the BN254 scalar field`);
  return parsed;
}

export function hash(hasher: PoseidonHasher, inputs: readonly bigint[]): bigint {
  const result = hasher(inputs);
  if (typeof result !== 'bigint' || result < 0n || result >= FIELD_SIZE) {
    throw new RangeError('Poseidon hasher returned an invalid field element');
  }
  return result;
}

export function amount(value: bigint, label: string, max = MAX_U64, positive = false): void {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must be bigint`);
  if (value < (positive ? 1n : 0n) || value > max) {
    throw new RangeError(`${label} must be ${positive ? 'positive' : 'nonnegative'} and at most ${max}`);
  }
}

export function leafIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_LEAVES) {
    throw new RangeError(`leaf index must be an integer in [0, ${MAX_LEAVES})`);
  }
}

export function bytes(value: unknown, length: number, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be a ${length}-byte Uint8Array`);
  }
}

export function publicKey(value: PublicKey, label: string): void {
  if (!(value instanceof PublicKey) || value.toBytes().length !== 32) {
    throw new TypeError(`${label} must be a Solana PublicKey`);
  }
}

export function fromBytes(value: Uint8Array, littleEndian = false): bigint {
  const source = littleEndian ? Uint8Array.from(value).reverse() : value;
  return BigInt(`0x${Buffer.from(source).toString('hex') || '0'}`);
}

export function toBytes(value: bigint, length: number, littleEndian = false): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(length * 8)) {
    throw new RangeError(`integer does not fit in ${length} bytes`);
  }
  const result = Uint8Array.from(Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex'));
  return littleEndian ? result.reverse() : result;
}

/** Fail closed if this runtime has no Web Crypto CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto getRandomValues is required; use a secure browser context or Node.js 22+');
  }
  const result = new Uint8Array(length);
  for (let attempt = 0; attempt < 32; attempt++) {
    crypto.getRandomValues(result);
    if (result.some(byte => byte !== 0)) return result;
  }
  throw new Error('CSPRNG repeatedly returned an all-zero secret');
}
