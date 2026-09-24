# Verification record

Reviewed September 24, 2026. These are engineering checks, not an independent
security audit or authorization to risk funds.

## Reproducible checks

| Check | Result |
| --- | --- |
| `npm run check` | Strict TypeScript checks and build passed; 75 offline tests passed. Four opt-in tests are skipped in the default run. |
| `ZKPAY_TEST_ARTIFACTS=<verified-directory> npm run test:proof` | Two real offline Groth16 tests passed using synthetic accounts and pinned production-compatible artifacts. |
| `npm run test:live-readonly` | Devnet and Mainnet genesis, supported account layouts, fees, public commitment history, and Merkle roots matched the configured deployments. |
| `npm run test:package` | Package allowlist, credential-pattern scan, side-effect-free Node import, and browser-bundle smoke passed. |
| `npm audit --audit-level=moderate` | No known dependency vulnerabilities reported for the resolved dependency tree at the time of this check. |

The real-proof round trip creates a deposit proof, decrypts the resulting note,
builds its Merkle membership path, proves a gross withdrawal, and recovers the
exact change. Native `snarkjs.groth16.verify` accepts both valid proofs and rejects
altered gross/fee public signals. No proof is submitted to a network.

The client tests simulate ambiguous RPC submissions, HTTP 400 relay responses,
unrelated failed signatures, wallet changes, signed-message mutation, expired
roots, prefunded nullifier PDAs, hanging providers, and confirmation deadlines.
Recovery tests also cover restart-time amount/recipient/effect tampering,
cross-wallet authentication, and immutable tracking metadata.

Live checks allow only public state/leaf GET requests and the read-only RPC
methods `getGenesisHash` and `getMultipleAccounts`. They neither load wallet
files nor call `relay`, `ingest`, or `sendTransaction`.

## CI

[SDK checks](https://github.com/zkPayonSOL/zkpay-sdk-solana/actions/workflows/ci.yml)
run on Node 22 and 24 with read-only repository permissions. Dependencies are
lockfile-pinned, installation scripts are disabled, and third-party Actions are
pinned by commit. Manual workflow dispatch additionally downloads hash-pinned
public artifacts and runs the real offline proof tests. CI has no wallet keys.

## Not established by these checks

- No funded end-to-end transaction was broadcast on either cluster.
- The browser check validates bundling/import, not every wallet extension or
  browser/WASM hosting configuration.
- Tests do not independently audit the deployed program, trusted setup,
  dependencies, upgrade authority, relayer, RPC, or indexer.
- Merkle checks authenticate commitments relative to the selected RPC, not
  ciphertext availability or RPC consensus truth.
- npm publication and redistribution licensing remain explicit owner decisions.

See [SECURITY.md](../SECURITY.md) and the [integration guide](sdk-usage.md) for the
operational trust boundaries and unknown-submission recovery requirements.
