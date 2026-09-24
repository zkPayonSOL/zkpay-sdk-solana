import type { PoseidonHasher } from '../protocol/validation.js';
import { FIELD_SIZE } from '../protocol/validation.js';

export interface LightWasmHasher { poseidonHashString(inputs: string[]): string; }

/** Wrap an already initialized LightWasm instance, including a browser's explicit WASM loader. */
export function createPoseidonHasher(lightWasm: LightWasmHasher): PoseidonHasher {
  if (!lightWasm || typeof lightWasm.poseidonHashString !== 'function') throw new TypeError('An initialized LightWasm hasher is required');
  return (inputs) => {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 12 ||
        inputs.some(value => typeof value !== 'bigint' || value < 0n || value >= FIELD_SIZE)) {
      throw new RangeError('Poseidon inputs must be 1 to 12 BN254 scalar field elements');
    }
    const output = lightWasm.poseidonHashString(inputs.map(String));
    if (typeof output !== 'string' || !/^(0|[1-9][0-9]*)$/.test(output)) throw new Error('Hasher returned an invalid field element');
    const result = BigInt(output);
    if (result >= FIELD_SIZE) throw new Error('Hasher returned an invalid field element');
    return result;
  };
}

/** Node default is lazy. In a browser provide initialize() with your bundler's explicit WASM loading. */
export async function createDefaultHasher(options: { initialize?: () => Promise<LightWasmHasher> } = {}): Promise<PoseidonHasher> {
  if (options.initialize) return createPoseidonHasher(await options.initialize());
  if (typeof window !== 'undefined' || typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Browser use requires createDefaultHasher({ initialize }) or createPoseidonHasher(initializedLightWasm)');
  }
  const { WasmFactory } = await import('@lightprotocol/hasher.rs');
  return createPoseidonHasher(await WasmFactory.getInstance());
}
