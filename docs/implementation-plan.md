# Mainnet SDK implementation plan

Target repository: `zkPayonSOL/zkpay-sdk-solana`.
Commit author: `zkPayonSOL <zkPayonSOL@users.noreply.github.com>`.

Current scope: native SOL on Solana Mainnet Beta only, with mandatory explicit
`network: 'mainnet-beta'`, exactly one caller-provided RPC URL or Connection,
and no automatic network/RPC default or fallback. Free public RPCs may be chosen
explicitly; zkPay's indexer/relayer API remains separate. Version 0.1.0 remains
unreleased; this scope change does not publish npm or modify any deployment.

1. Research the current Privacy Cash Solana SDK and record design/provenance
   decisions; scaffold an independently implemented SDK and amount/fee tests.
2. Port and harden zkPay's own protocol primitives, with byte-level fixtures,
   encrypted-note validation and strict two-input transaction selection.
3. Add explicit Mainnet-only configuration, deterministic Mainnet signing compatibility,
   dependency-injected wallets, HTTP/RPC boundaries and pinned proving artifacts.
4. Implement verified pool synchronization, private-balance queries, unsigned
   deposits and relayed withdrawals with truthful confirmation/error states.
5. Validate real Groth16 proofs offline, package imports, browser bundling,
   dependency/secret scans, examples and complete integration documentation.
6. Push each tested stage using authorized GitHub access. No contract deployment,
   live-money operation, npm release or modification of the original application.

The original application repository remains read-only. Public on-chain constants
and user-owned protocol source may be referenced; private configurations and
wallet material are excluded. Privacy Cash is a design reference, not a code,
circuit or artifact source for this SDK. Do not impose a new license on code
whose provenance has not been established.
