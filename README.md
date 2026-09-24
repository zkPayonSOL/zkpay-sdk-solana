# zkPay Solana SDK

TypeScript client for zkPay's native SOL privacy pools. It supports explicit Devnet and Mainnet Beta configuration, wallet-based unlock, local note scanning and Groth16 proving, unsigned deposit preparation, relayed withdrawals, and payment-status recovery.

This repository is a source distribution under development. `package.json` currently sets `private: true` and `license: "UNLICENSED"`; publication and licensing remain owner decisions. These instructions do not assume a published npm package. This SDK has not been independently audited.

## Build from source

Use Node.js 22 or later and npm:

```sh
git clone https://github.com/zkPayonSOL/zkpay-sdk-solana.git
cd zkpay-sdk-solana
npm ci
npm run check
```

Repository access may require GitHub authentication. `npm run check` type-checks, runs the default offline tests, and builds `dist/`. From an `.mjs` file in the repository root, import the local build:

```js
import { parseSol, formatSol, quoteWithdrawal } from './dist/index.js';

const quote = quoteWithdrawal(parseSol('0.1'));
console.log({
  grossSol: formatSol(quote.grossLamports),
  feeSol: formatSol(quote.feeLamports),
  recipientSol: formatSol(quote.recipientLamports),
});
// { grossSol: '0.1', feeSol: '0.0062', recipientSol: '0.0938' }
```

From another local project, use a relative path to this checkout's `dist/index.js`, with the checkout's dependencies installed. Do not replace this with an unverified package of the same name.

## Read a private balance

Your application supplies a `WalletSigner` with `publicKey`, `signMessage`, and `signTransaction`. `createKeypairWallet(keypair)` adapts an in-memory Solana `Keypair` for Node applications; browser applications normally adapt their connected wallet.

```ts
import { ZkPayClient, formatSol } from './dist/index.js';
import type { WalletSigner } from './dist/index.js';

export async function readBalance(wallet: WalletSigner) {
  const client = await ZkPayClient.create({ network: 'devnet', wallet });
  try {
    await client.unlock(); // Requests a sensitive, deterministic message signature.
    const balance = await client.getPrivateBalance();
    return {
      totalSol: formatSol(balance.balanceLamports),
      spendableInOnePaymentSol: formatSol(balance.spendableLamports),
    };
  } finally {
    client.dispose();
  }
}
```

This function reads network state and requests an unlock signature; it never submits a transaction. Mainnet is selected only by explicitly passing `network: 'mainnet-beta'`. Preserve the signing host used for the original deposits: another host derives another private account. In a browser, the host must match the current page.

`verified: true` on a balance means the commitment tree and relevant RPC account checks passed. It does **not** prove that the indexer supplied every authentic encrypted note. A malicious indexer can hide or alter ciphertext and cause a balance to be underreported. Owned-nullifier lookups also expose their association to the selected RPC provider. Read the [security model](SECURITY.md) before integrating.

## Prepare, review, then submit

`prepareDeposit({ lamports })` returns an unsigned transaction and an intent. `prepareWithdrawal({ lamports, recipient })` returns a quote and an intent while retaining the proof in the client. Both prove locally and do **not** broadcast.

The explicit submission methods are `submitDeposit(prepared)` and `submitWithdrawal(prepared)`. Convenience methods `deposit(...)` and `send(...)` also submit transactions. Save the payment intent before using a submission method. If the outcome is unknown, retain its tracking metadata and use `resumePayment`, `getPaymentStatus`, or `waitForConfirmation`. Never blindly resubmit or create a replacement payment because a request timed out.

Preserve the complete intent, including its SDK-generated `authentication` field. This account-bound authentication is checked after unlock and before trusting restored tracking metadata. Applications should not compute, remove, or rewrite it. A restored `status` or `signature` is only a hint, not proof of confirmation or failure.

All amounts are `bigint` lamports. Withdrawal `lamports` is the **gross private-balance debit**. The default fee is `floor(gross × 20 / 10,000) + 6,000,000` lamports; the recipient receives the remainder. Use the verified current `feePolicy` when displaying a quote. The deployed circuit consumes at most two notes, so `spendableLamports` can be lower than `balanceLamports`. An insufficient or fragmented balance fails; it never silently sends a partial amount.

This release supports native SOL only. It does not provide SPL-token operations, a standalone merge operation, or private internal transfers. Deposits may consolidate up to two existing notes as part of adding SOL.

## Local proving artifacts

The default prover downloads zkPay's pinned artifacts only when proving is first requested. To explicitly download them for offline use:

```sh
npm run artifacts:download
ZKPAY_TEST_ARTIFACTS=.artifacts npm run test:proof
```

The download writes ignored `.artifacts/` files only after all expected sizes and SHA-256 hashes pass. The proof tests use synthetic data for a real proof and a deposit → scan → withdrawal → change roundtrip, including native proof verification and rejection of altered public signals. They do not access a wallet or move funds. Normal tests skip these cases unless `ZKPAY_TEST_ARTIFACTS` is supplied.

`npm run test:package` checks the package file allowlist, credential patterns, Node import behavior, and a browser bundle without broadcasting. `npm run test:live-readonly` explicitly contacts the configured Devnet and Mainnet public endpoints to check genesis, account layouts, and commitment synchronization; its request guard permits only reads and it uses an unfunded synthetic identity. It never submits a transaction or transfers funds. Live checks may fail when endpoints are unavailable or the indexer lags; they are not an independent security audit.

Browser integrations must initialize the Poseidon WASM hasher explicitly. Third-party browser origins cannot assume the official API permits their CORS requests: provide a backend proxy or a compatible self-hosted API and configure `apiUrl`. See [browser setup and artifact handling](docs/sdk-usage.md#browser-integration).

## Documentation and examples

- [SDK usage and API guide](docs/sdk-usage.md)
- [Security, trust boundaries, and reporting](SECURITY.md)
- [Design reference and provenance](docs/design-reference.md)
- [Verification record and limitations](docs/verification.md)
- [Offline fee quote](examples/quote.ts): `node --import tsx examples/quote.ts`
- [Read-only balance helper](examples/read-balance.ts)
- [Prepare without broadcasting](examples/prepare-only.ts)
- [Explicit browser initialization](examples/browser.ts)
- [Resume payment tracking without resubmission](examples/resume-payment.ts)

Only the fee quote example runs at the top level. The other examples export functions for your application to call; importing them never reads a private key, contacts an API, or broadcasts a transaction.
