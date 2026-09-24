# Changelog

## 0.1.0 — unreleased

- Establish an independent, Mainnet-only native-SOL SDK with exact lamport arithmetic and
  the deployed percentage-plus-fixed gross withdrawal fee model.
- Require an explicit `network: 'mainnet-beta'` option with no automatic default.
- Require exactly one caller-provided RPC URL or Connection; remove the former
  public-proxy default and provide no automatic fallback. Free public RPCs may
  be selected explicitly. The indexer/relayer API remains a separate service.
- Preserve the deployed Mainnet signing message, encrypted notes,
  Poseidon commitments, Merkle paths, and Solana transaction encoding.
- Add an explicitly unlocked client with prepared deposits, relayed withdrawals,
  validated pool state, and resumable unknown-outcome tracking without retries.
- Add bounded transports, public-only caches, pinned local Groth16 artifacts,
  real offline proof verification, and opt-in read-only deployment checks.
- Provide typed wallet/prover/storage interfaces, English integration examples,
  package and browser-bundle checks, and least-privilege CI.
- Keep version 0.1.0 unreleased, npm publication disabled, and redistribution licensing undecided.
