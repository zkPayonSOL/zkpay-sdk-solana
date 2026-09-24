# Mainnet verification record

Reviewed September 24, 2026. These are engineering checks, not an independent
security audit or authorization to risk funds.

Current supported scope is native SOL on Mainnet only, with a mandatory
caller-provided RPC URL or Connection. This record lists reproducible checks
for that scope. Use CI and command output for current run-specific results.

For the required-RPC revision, strict type checking/build, 88 offline tests,
package/import checks, and dependency auditing passed locally. Three opt-in
checks remain skipped in the default test run. The live read-only check also
passed with an explicitly selected public Mainnet RPC; no transaction was sent.

## Reproducible checks

| Check | Current verification scope |
| --- | --- |
| `npm run check` | Strict type checks, build, offline tests, rejection of unsupported networks, and mandatory/exclusive caller RPC selection. Opt-in checks remain skipped without their explicit configuration. |
| `ZKPAY_TEST_ARTIFACTS=<verified-directory> npm run test:proof` | Real offline proof and roundtrip verification using synthetic accounts and pinned Mainnet-compatible artifacts. |
| `ZKPAY_TEST_RPC_URL=<your-mainnet-rpc> npm run test:live-readonly` | Mainnet genesis, supported account layouts, fees, public commitment history, and Merkle roots checked using the caller-selected RPC. Read requests only; no default proxy or fallback. |
| `npm run test:package` | Package allowlist, credential-pattern scan, Node import, and browser-bundle smoke; no unsupported network or default RPC export. |
| `npm audit --audit-level=moderate` | Dependency advisory check for the resolved tree at run time. This is not an independent code audit. |

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

The live check requires `ZKPAY_TEST_RPC_URL` when explicitly enabled. The SDK and
live check require the caller's own RPC selection; neither silently falls back
to the web application's proxy. Removing the SDK default does not modify the
deployed proxy or web application.

## CI

[SDK checks](https://github.com/zkPayonSOL/zkpay-sdk-solana/actions/workflows/ci.yml)
run on Node 22 and 24 with read-only repository permissions. Dependencies are
lockfile-pinned, installation scripts are disabled, and third-party Actions are
pinned by commit. Manual workflow dispatch additionally downloads hash-pinned
public artifacts and runs the real offline proof tests. CI has no wallet keys.

## Not established by these checks

- No funded end-to-end transaction is broadcast by these checks. They do not establish successful live-money execution on Mainnet.
- The browser check validates bundling/import, not every wallet extension or
  browser/WASM hosting configuration.
- Tests do not independently audit the deployed program, trusted setup,
  dependencies, upgrade authority, relayer, RPC, or indexer.
- Merkle checks authenticate commitments relative to the selected RPC, not
  ciphertext availability or RPC consensus truth.
- npm publication and redistribution licensing remain explicit owner decisions.

See [SECURITY.md](../SECURITY.md) and the [integration guide](sdk-usage.md) for the
operational trust boundaries and unknown-submission recovery requirements.
