declare module 'snarkjs' {
  export const groth16: {
    fullProve(input: unknown, wasm: Uint8Array, zkey: Uint8Array, logger?: undefined,
      witnessOptions?: { singleThread: boolean }, proverOptions?: { singleThread: boolean }): Promise<{ proof: unknown; publicSignals: unknown }>;
  };
}
