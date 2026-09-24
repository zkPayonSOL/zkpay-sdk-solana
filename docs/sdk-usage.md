# SDK usage

This SDK supports native SOL on Solana Mainnet. The examples in this guide import the local build from an application file at the repository root. Run `npm ci && npm run build` first. Node.js 22+ is required.

## Amounts and fees

Every monetary API uses integer `bigint` lamports. Convert human input with `parseSol('0.1')`, never `Number('0.1') * 1e9`. `parseSol` rejects signs, exponent notation, and more than nine fractional digits. `formatSol` renders an exact decimal string. Transaction amounts must be positive and within the supported signed 64-bit range.

```ts
import { parseSol, formatSol, quoteWithdrawal } from './dist/index.js';

const quote = quoteWithdrawal(parseSol('0.1'));
// Gross debit: 100000000n; fee: 6200000n; recipient: 93800000n.
console.log(formatSol(quote.recipientLamports)); // '0.0938'
```

The default fee policy is 20 basis points plus 6,000,000 lamports:

```text
fee = floor(grossLamports * basisPoints / 10000) + baseLamports
recipientLamports = grossLamports - fee
```

The client validates the actual pool policy against RPC state. Quote with `quoteWithdrawal(gross, balance.feePolicy)` to use that verified snapshot. Submission checks for policy changes. A gross amount that does not exceed the fee is rejected. Deposits have no protocol fee in this SDK, but the depositing wallet still pays Solana transaction fees and applicable rent. Priority fees are additional wallet costs, not a reduction of the supplied deposit amount.

`bigint` cannot be passed directly to `JSON.stringify`. Convert presentation fields to strings; `PaymentIntent` already uses JSON-safe decimal strings for amounts.

## Wallets and explicit Mainnet configuration

```ts
import { ZkPayClient, createKeypairWallet, MemoryPoolStorage } from './dist/index.js';
import type { WalletSigner } from './dist/index.js';

// Node: obtain an in-memory Keypair from your application's established secret manager.
// const wallet = createKeypairWallet(keypair);

export async function openClient(wallet: WalletSigner, rpcUrl: string) {
  const client = await ZkPayClient.create({
    network: 'mainnet-beta', // Required: native SOL in a real-funds context.
    wallet,
    rpcUrl, // Required caller choice; a free public or private Mainnet RPC is allowed.
    signingHost: 'app.zkpay.sh', // Node only: preserve the original deposit's signing host.
    storage: new MemoryPoolStorage(), // Optional, public pool data only.
  });
  await client.unlock();
  return client;
}
```

The SDK never searches disk for a wallet or loads a `.env` file. Pass `createKeypairWallet` an existing in-memory `Keypair`, or implement:

```ts
interface WalletSigner {
  readonly publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}
```

Message signing must be deterministic. The SDK checks signatures and transaction-message integrity, but cannot establish future signing determinism from one signature. A wallet switch requires a new client. Dispose the previous client and preserve any unresolved payment metadata before switching.

`network` is mandatory and its only supported value is `'mainnet-beta'`. It is not inferred or defaulted: every caller must explicitly acknowledge the Mainnet context, even for reads. The SDK checks the configured RPC's Mainnet genesis hash and rejects other clusters. These are the constants pinned in this release:

| Network | Program | Default indexer/relayer API prefix |
| --- | --- | --- |
| `mainnet-beta` | `98Bj9K8iPV1JiVqBWXzY4bX4wsrm2x5DgEbiToybm9hx` | `https://app.zkpay.sh/api/mainnet` |

These constants identify the supported deployment; they are not a promise of endpoint availability or a deployment audit. `MAINNET` contains no default RPC. Every `ZkPayClient.create` call must provide exactly one of these options:

```ts
type RpcChoice =
  | { rpcUrl: string; connection?: never }
  | { connection: Connection; rpcUrl?: never };
```

Both missing and both supplied are rejected by the public types and runtime checks. Your application's existing connection can be injected without separately passing a URL:

```ts
import { Connection } from '@solana/web3.js';
import { ZkPayClient } from './dist/index.js';
import type { WalletSigner } from './dist/index.js';

export function clientUsingConnection(wallet: WalletSigner, connection: Connection) {
  return ZkPayClient.create({ network: 'mainnet-beta', wallet, connection });
}
```

A caller may explicitly choose the free public Mainnet RPC `https://api.mainnet.solana.com`, which is listed in [Solana's official RPC documentation](https://solana.com/docs/references/clusters#mainnet). Public RPCs are shared, rate-limited, and may reject traffic; this SDK supplies no availability SLA. Use a service appropriate for your traffic and privacy needs. There is no automatic switch to a public endpoint, zkPay proxy, or another provider if your chosen RPC fails.

The `apiUrl` option is independent: it selects zkPay-compatible indexer and relayer HTTP services and retains the official prefix above as its default. Your required RPC handles genesis/account reads, nullifier checks, signature status, and deposit submission. Supplying a custom RPC does not remove the indexer/relayer dependency, and an API-advertised RPC cannot replace it. At the low level, `NetworkConfig.rpcUrl` is optional metadata for a caller-supplied URL; its absence never requests a fallback.

You may override `apiUrl` and choose your RPC, but cannot silently change the pinned program/relayer identity through an API response. With `rpcUrl`, the SDK constructs the Solana `Connection`; an injected `connection` uses that instance's own transport configuration. Configure its fetch implementation and underlying transport in your application rather than expecting the SDK to replace them. Use HTTPS; HTTP API/RPC endpoints are accepted only for explicit localhost development. Embedded URL credentials are rejected. An RPC query-string API token, if used, must not be logged.

The Mainnet unlock message binds the signing host, account, network, and program. Node defaults the signing host to `app.zkpay.sh`; it does not default the network option. Browsers use `location.host` and reject a different `signingHost`. A balance created at one host will not appear when unlocking for another host. Preserve that original context when recovering Mainnet funds. Other-cluster balances are outside this SDK's scope.

## Balance synchronization and cache

```ts
const balance = await client.getPrivateBalance({ signal });
const quote = quoteWithdrawal(parseSol('0.1'), balance.feePolicy);
```

`getPrivateBalance` requires `unlock()`. Its result includes:

| Field | Meaning |
| --- | --- |
| `balanceLamports` | Sum of detected owned notes whose queried nullifier accounts are unspent. |
| `spendableLamports` | Maximum gross debit covered by the two largest unspent notes. |
| `noteCount` | Number of detected owned unspent notes. |
| `leafCount`, `root` | Verified commitment-tree snapshot. |
| `feePolicy`, `maxDepositLamports`, `shutdownAt` | Supported pool policy checked against the selected RPC. |
| `verified` | Commitment-tree and relevant RPC checks passed; see limitations below. |

A valid commitment root does not authenticate the associated encrypted-output availability. A malicious indexer can return the correct commitments with altered/missing ciphertext, causing an underreported balance even when `verified` is true. RPC checks trust the selected RPC's responses. They do not constitute an independent Solana light client. Spent checks send owned-nullifier PDAs to that RPC, exposing their association to the provider. See [SECURITY.md](../SECURITY.md#indexer-and-rpc-trust).

The SDK scans public leaves locally and sends no owned-note list to the indexer. The optional `PublicPoolStorage`/`PoolStorage` interface provides asynchronous `load(namespace)`, `save(namespace, snapshot)`, and `remove(namespace)`. Snapshots contain only version, namespace, and public `LeafRecord[]`; implement atomic snapshot replacement. The namespace includes protocol version, network, genesis hash, program, and API URL, so changing indexers selects a separate cache. The RPC URL is excluded because its query string may contain an API credential. Caches are revalidated before use and are not a key-recovery mechanism.

There is no standalone merge API. If total funds are sufficient but the two available input slots cannot cover a withdrawal, `NotesFragmentedError` reports the requested gross amount, reachable amount, total, and note count. The SDK never reduces the payment amount automatically. Deposits can consolidate up to two existing notes as part of adding funds.

## Preparation without broadcasting

```ts
const deposit = await client.prepareDeposit({
  lamports: parseSol('0.01'),
  priorityFeeMicroLamports: 1_000,
});
// deposit.transaction is unsigned. Nothing has been submitted.
// Keep this exact object with the same live client for an intentional submission.

const withdrawal = await client.prepareWithdrawal({
  lamports: parseSol('0.1'), // Gross debit, including fee.
  recipient: recipientPublicKey,
});
// Review withdrawal.intent and withdrawal.quote. Nothing has been submitted.
```

Preparation reads pool/RPC state and creates a local proof. It can therefore fetch artifacts and take CPU time. A prepared deposit includes `transaction`, `intent`, and `lastValidBlockHeight`; a prepared withdrawal includes `intent` and `quote`. Proofs and witness data are not part of the public withdrawal result.

Prepared objects are bound to the client instance that produced them. They cannot be serialized and restored for submission in another process. Prepare close to the intended submission time: blockhashes and retained roots expire, and fee policy or spent inputs may change. An expired preparation that was never submitted can be reviewed and prepared again; an unknown submission must first be reconciled.

## Intentional submission and recovery

The following code **can move funds when called**. Keep submission behind your application's explicit review action. `persist` must durably store the payment record in private application storage; it must not be a public log or analytics event.

Persist the complete SDK-produced `PaymentIntent`, including `authentication`. This is a 64-character hexadecimal HMAC-SHA256 tag bound to the private account. Its key is derived from the spending secret using the `zkpay/sdk/payment-intent-key/v1` domain; it authenticates the ID, kind, network, program, root, gross amount, fee, recipient, nullifiers, and output commitments. Do not remove or rewrite the tag, and do not calculate it in application code. The high-level preparation methods include it automatically.

```ts
import { SubmissionUnknownError } from './dist/index.js';
import type { PendingPayment, PreparedWithdrawal, ZkPayClient } from './dist/index.js';

export async function submitReviewedWithdrawal(
  client: ZkPayClient,
  prepared: PreparedWithdrawal,
  persist: (payment: PendingPayment) => Promise<void>,
): Promise<PendingPayment> {
  // Save enough metadata to resume even if the process dies during submission.
  await persist({ status: 'unknown', intent: prepared.intent });
  let payment: PendingPayment;
  try {
    payment = await client.submitWithdrawal(prepared);
  } catch (error) {
    if (!(error instanceof SubmissionUnknownError)) throw error;
    payment = error.payment;
  }
  await persist(payment);
  return payment; // 'submitted' or 'unknown'; this is not settlement confirmation.
}
```

`submitDeposit(prepared)` requests the transaction signature and sends the signed transaction through the configured RPC. `submitWithdrawal(prepared)` sends the public proof and extData to the relayer. `deposit(...)` and `send(...)` combine preparation and submission, so they are not preview methods. Use the separate prepare/submit methods when durable intent capture or review is required.

If post-submission persistence fails, retain the pre-submission intent and inspect `client.pendingPayment` in the live process. Do not interpret a storage error as authorization to submit again. A prepared object is single-use once submission is attempted.

After a restart, load the previously stored record and only resume tracking:

```ts
// The client must use the same network, wallet, and signing host as before.
client.resumePayment(savedPayment); // No broadcast; while locked, only shape/pool checks are possible.
await client.unlock(); // Authenticates the restored intent for this wallet/network/signing host.
const status = await client.getPaymentStatus(savedPayment);
// Optionally: await client.waitForConfirmation(savedPayment, {
//   timeoutMs: 90_000, pollIntervalMs: 2_000, signal,
// });
```

| Status | Interpretation and next action |
| --- | --- |
| `submitted` | A submission path returned a signature. Check status; do not submit again. |
| `unknown` | The request may already have been submitted. Preserve the intent and perform status checks only. |
| `confirmed` | The expected adjacent outputs and spent inputs were checked against the selected RPC/pool data. Not a finalized-consensus guarantee. |
| `failed` | A deposit signed locally in this live client has a matching RPC-confirmed failure. A restored signature alone cannot establish this state. |

The outer `status` and optional `signature` are not authenticated by the intent MAC and remain tracking hints. The relayer's `confirmed` flag is not accepted as settlement proof. Unlock and status checking authenticate the intent before checking its effects. A tampered or wrong-account record fails authentication; do not strip its tag to bypass that failure.

Polling timeout returns a pending result, not `failed`. An aborted or failed status check also does not establish non-submission. After a restart, the client no longer has the original live association between a locally signed deposit and its signature; a restored signature reporting an error does not establish definite payment failure. A relayed withdrawal with uncertain submission can likewise remain unresolved without a reliable signature. Investigate the saved authenticated intent rather than retrying it. While an intent is pending, the client blocks another preparation. Do not bypass that protection with a new client.

## Proving artifacts

`createProver()` is lazy: construction/import starts no download. The first proof loads the pinned artifacts, and successful loads are cached in memory per prover. Failed loads can be retried. Network responses are bounded by expected size and a deadline; redirects and request credentials are disabled.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `transaction2.wasm` | 3,208,099 | `a277631b7616c2c0bfd78a1648b069972ac6020e5509ae8f9bfc8772bdc70ec1` |
| `transaction2.zkey` | 16,462,377 | `018ae5ce79df66c4bb86a384b96a68d0db3513902078823aa0bfe07f99f2813d` |
| `verifyingkey2.json` | 4,022 | `b8bf705bb74bda38c3ec609e3eb0bc4eda777a4504ff524b794d494df9b61467` |

The canonical definitions are `ARTIFACT_MANIFEST`. `verifyArtifact(name, bytes)` and `verifyArtifacts(bytes)` return owned verified copies. `downloadArtifact(name, options)` and `downloadArtifacts(options)` support `baseUrl`, injected `fetch`, `signal`, and `timeoutMs` (default 60 seconds per artifact). Custom hosting changes the location, not the expected protocol hashes.

```ts
import { readFile } from 'node:fs/promises';
import { createProver, ZkPayClient } from './dist/index.js';

const prover = createProver({
  artifacts: {
    wasm: await readFile('.artifacts/transaction2.wasm'),
    zkey: await readFile('.artifacts/transaction2.zkey'),
    verifyingKey: await readFile('.artifacts/verifyingkey2.json'),
  },
});
// wallet and rpcUrl are explicitly supplied by the application.
const client = await ZkPayClient.create({ network: 'mainnet-beta', wallet, rpcUrl, prover });
```

The same verified bytes are passed to `snarkjs`; there is no second URL fetch between verification and proving. `createProver` validates supplied bytes at construction. It uses the documented `fullProve` witness/prover single-thread options to avoid lingering worker threads, then checks proof shape, coordinate ranges, and all seven public signals against the witness. It does not implement a custom pairing verifier. The program verifies proofs on chain, and the opt-in real-proof test independently verifies with native `snarkjs` in a child process.

Only inject a trusted local `ProofProvider`: it receives spend secrets and the full witness. `serializeGroth16Proof` is an encoding-and-binding helper, not a mathematical verifier. The pinned vkey's presence does not mean every provider call runs `groth16.verify` locally.

## Validation commands

```sh
npm run check
npm run test:package
npm run artifacts:download
ZKPAY_TEST_ARTIFACTS=.artifacts npm run test:proof
```

`check` type-checks, runs default offline tests, and builds. `test:package` checks the package allowlist and credential patterns, then exercises Node import and a browser bundle without starting network requests or broadcasting. `artifacts:download` explicitly fetches the public pinned artifacts into ignored `.artifacts/`. `test:proof` uses those local bytes for real Groth16 proof generation, independent native verification, and a synthetic deposit → scan → withdrawal → change roundtrip that rejects altered public signals. No proof test accesses a funded wallet or submits a transaction. Without `ZKPAY_TEST_ARTIFACTS`, the real-proof cases are skipped.

For an explicit network read check:

```sh
ZKPAY_TEST_RPC_URL=https://api.mainnet.solana.com npm run test:live-readonly
```

The command explicitly chooses the displayed public RPC; substitute your own Mainnet RPC URL if preferred. `ZKPAY_TEST_RPC_URL` is required for this opt-in check, and there is no fallback. The command contacts that RPC and the zkPay indexer only. It uses an unfunded synthetic identity and a request guard that permits only allowlisted RPC reads and public state/leaf endpoints. It checks cluster identity, deployed account layouts, and bounded Merkle synchronization; it does not unlock a real wallet, broadcast, or transfer funds. Endpoint failures, indexer lag, or smoke-test resource limits can cause a failure without implying a protocol defect. These checks are implementation validation, not an independent audit.

## Browser integration

Browser applications need Web Crypto, a wallet supporting the required signatures, an explicitly initialized Poseidon hasher, and browser-accessible artifacts. Bundler WASM deployment is the application's responsibility.

```ts
import { ZkPayClient, createDefaultHasher, createProver } from './dist/index.js';
import type { LightWasmHasher, WalletSigner } from './dist/index.js';

export async function createBrowserClient(
  wallet: WalletSigner,
  initializeWasm: () => Promise<LightWasmHasher>,
  apiUrl: string,
  rpcUrl: string,
) {
  const hasher = await createDefaultHasher({ initialize: initializeWasm });
  const prover = createProver({ baseUrl: new URL('/zkpay-artifacts/', location.origin) });
  return ZkPayClient.create({ network: 'mainnet-beta', wallet, apiUrl, rpcUrl, hasher, prover });
}
```

For `@lightprotocol/hasher.rs`, the application can use its `WasmFactory.loadHasher({ wasm: wasmBytes })` loader with bytes imported or served by the bundler. Return that initialized instance from `initializeWasm`, or pass it to `createPoseidonHasher(instance)`. Serve the three pinned transaction artifacts under the configured artifact directory. Do not assume dependency WASM files appear automatically in a browser's public directory. Do not import the Node `fs` offline-loading example into a browser bundle.

The official indexer/relayer API restricts browser CORS for third-party origins. A third-party application should supply a controlled backend proxy or compatible self-hosted API via `apiUrl`. Independently, supply a browser-accessible trusted RPC through the required `rpcUrl` or `connection` choice; the API proxy is not an RPC default. CORS restrictions also apply to artifact hosting unless the files are same-origin or explicitly permit access. A proxy never needs the unlock signature or private witness.

Leave `signingHost` unspecified in the browser so it resolves to `location.host`. A third-party origin represents a different private account from `app.zkpay.sh`; this is part of the signing domain boundary, not a balance-discovery bug.

## Lifetimes, cancellation, and low-level APIs

Create one client per selected wallet/network/signing-host context. Operations within a client are serialized by rejection of concurrent calls. Coordinate separate tabs/processes yourself. Call `dispose()` on disconnect after preserving unresolved payment metadata. `dispose` is best-effort key cleanup and cannot undo a submitted transaction or erase a caller-owned keypair.

High-level async operations accept `{ signal }`. HTTP requests, synchronization, and confirmation polling are bounded, but underlying wallet prompts, injected transports, or CPU-bound proving may not support immediate interruption. The default client builds its own lazy prover; to set artifact timeout/abort options explicitly, construct a prover with those options and inject it. Aborting after submission is never proof that no transaction was sent.

Advanced integrations can use `ProtocolAccount`, `MerkleTree`, `PoolSynchronizer`, `HttpApi`, and instruction builders directly. These interfaces do not automatically provide every high-level safety check. `ProtocolAccount.scan` detects/decrypts notes but does not establish on-chain unspent status. `PoolSynchronizer` adds commitment-root/RPC checks. `buildTransactIx` encodes instructions but does not obtain wallet approval or verify a deployment. Avoid substituting a raw scanner result for a verified spendable balance.

`HttpApi` also checks the endpoint's Mainnet `/state` identity before its first
leaf, nullifier, ingest, or relay request. A successful state check is cached for
that instance; a later failed explicit state check clears it. Custom endpoints
must return the expected Mainnet network, genesis, program, relayer, and disabled
faucet identity. This check does not replace the high-level client's RPC checks
or make a malicious endpoint trustworthy.

This unreleased 0.1.0 SDK exposes native SOL Mainnet flows only. Other clusters, SPL tokens, standalone merge, and private internal transfers are not implemented.
