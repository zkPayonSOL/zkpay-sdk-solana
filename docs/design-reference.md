# Solana SDK design reference

Reviewed September 24, 2026. This is an architectural comparison, not a security
audit, endorsement, or claim of protocol interchangeability.

## Reference baseline

- [Privacy Cash Solana SDK](https://github.com/Privacy-Cash/privacy-cash-sdk/tree/18fe62c63f780435805c7e65f340de9e2c6cbc55),
  `privacycash` 1.2.2, commit `18fe62c63f780435805c7e65f340de9e2c6cbc55`.
- [Official browser example](https://github.com/Privacy-Cash/solana-sdk-demo-interface/tree/df7df0198dc202ba8d13292fd07a05b55f5d7cd3).
- [Protocol reference](https://github.com/Privacy-Cash/privacy-cash/tree/aa6818b76b23edcf05b8b9829a9cd900fdb1d241).

The useful architectural pattern is a convenient high-level client over
independently usable components: wallet signing, local note scanning, storage,
proof generation, transaction building and relayer transport. The reference
provides a Node facade and injected browser utilities around these operations.
Its API covers deposits, withdrawals and private-balance queries.

## zkPay decisions

| Concern | Decision |
| --- | --- |
| Public API | Explicit network, wallet and transport; a high-level client plus typed building blocks. |
| Amounts | `bigint` lamports and strict decimal parsing; never floating-point SOL. |
| Fees | Gross amount is the total debit; validate the deployed percentage-plus-fixed model and show recipient net in the quote. |
| Wallet identity | Match zkPay's exact existing signing messages and derivation. A different signing host derives a different balance. |
| Protocol | zkPay's own commitments, note encryption, PDA seeds, instruction encoding and current proving parameters. |
| Randomness | Fail-closed cryptographic randomness; no `Math.random` for keys or blindings. |
| Scanning | Fetch public leaves, decrypt locally, verify commitments/root and check spent markers on chain. Do not send owned-note lists to an indexer. |
| State | Per-client state; no module-level wallet, storage directory or perpetual polling loop. |
| Caching | Optional storage of public encrypted pool data only, full network/program/endpoint namespace and atomic snapshot writes. |
| Two-input limit | Reject fragmented/insufficient spendable balances explicitly, never silently withdraw a partial amount. |
| Proving | Local Groth16 proving with pinned artifact sizes and SHA-256 hashes before use. Never send a private witness to a service. |
| Submission | Separate prepared, submitted, confirmed and indexed outcomes; a timeout is not proof of failure. No blind payment retries. |
| Browser integration | No Node private-key requirement. Official Mainnet API CORS currently restricts browser origins; third-party apps need their own server adapter or compatible service. |
| Scope | Native SOL deposits and relayed withdrawals. Do not expose unsupported zero-external-amount transfers, merges or SPL token flows. |

## Provenance

The Privacy Cash SDK package metadata declares ISC, while the related protocol
repository has separate BSL 1.1 terms. Those declarations do not establish a
single permission to copy the whole system. This repository does not copy the
competitor's SDK implementation, circuit, proving artifacts, branding, account
identifiers or signing message. It independently implements integration with
the deployed zkPay protocol using the owner's existing public-format protocol
code and compatibility fixtures. No new redistribution license is assigned
without the owner's explicit release decision.

Sources: [SDK API](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/src/index.ts),
[browser utilities](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/src/exportUtils.ts),
[deposit](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/src/deposit.ts),
[withdrawal](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/src/withdraw.ts),
[note scanning](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/src/getUtxos.ts),
[SDK metadata](https://github.com/Privacy-Cash/privacy-cash-sdk/blob/18fe62c63f780435805c7e65f340de9e2c6cbc55/package.json),
[protocol license](https://github.com/Privacy-Cash/privacy-cash/blob/aa6818b76b23edcf05b8b9829a9cd900fdb1d241/LICENSE.md).
