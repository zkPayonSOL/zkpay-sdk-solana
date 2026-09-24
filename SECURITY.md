# Security model

This SDK handles spend-authorizing material for native SOL on Solana Mainnet Beta only. Client creation requires `network: 'mainnet-beta'` explicitly, including for read-only integrations; there is no automatic network default. Submission methods operate in a real-funds context. The new SDK itself has not been independently audited. Its type checks, tests, artifact hashes, and local protocol validations do not establish the security of a deployment, RPC provider, host application, or wallet implementation.

## Keys, unlock signatures, and origin binding

`unlock()` obtains a wallet message signature and derives the deployed zkPay spending secret. The signature is sensitive: possession can enable reconstruction of the private account's spending key. Never log it, send it to a server, add it to analytics, or store it in localStorage, a database, or a crash report.

The wallet must return a valid, deterministic Ed25519 signature for the same exact unlock message. Signature verification alone does not prove determinism across sessions. Test the chosen wallet's signing behavior before funding it. Adapters without message signing or v0 transaction signing are unsupported; do not assume a hardware-wallet integration meets these requirements.

The Mainnet signature message binds the signing host, account, network, and configured program. Keep the original host and account when recovering an existing Mainnet balance. A browser is prevented from requesting an unlock signature for a host other than `location.host`. A third-party site consequently derives a different private account from the official application. Do not bypass this check by asking a user to copy an official application's signature. This SDK does not recover balances from other Solana clusters.

The SDK keeps spending material in memory and does not persist unlock signatures, decrypted notes, or private witnesses. `dispose()` invalidates the client and performs best-effort cleanup. JavaScript cannot guarantee erasure of every copy made by the VM, wallet, application, or injected prover. The `createKeypairWallet` adapter retains its own keypair copy while the adapter is reachable; disposing a client does not erase caller-owned wallets or secrets.

## Indexer and RPC trust

Every client must receive exactly one caller-controlled `rpcUrl` or `Connection`; both omitted or both supplied is an error. The SDK has no built-in RPC proxy, default public RPC, or automatic failover. A free public Mainnet endpoint is allowed when explicitly selected, but shared services can throttle or block requests; the SDK supplies no availability SLA. See [Solana's public RPC limits](https://solana.com/docs/references/clusters#mainnet-rate-limits).

No RPC provider credentials are embedded in the SDK. Caller-supplied RPC URLs may contain credentials: do not log them or bundle private server credentials into a browser application. Use a controlled server-side proxy when credentials must remain private. zkPay's indexer/relayer API remains a separate dependency and must not silently choose the caller's RPC.

The synchronizer rebuilds a Merkle tree from contiguous public commitments, checks it against the selected RPC's pool state, validates supported account layouts and policy, and queries nullifier accounts to exclude spent notes. A network mismatch, incomplete commitment list, inconsistent root, or unavailable spent-state check fails closed.

`PrivateBalance.verified === true` has a narrower meaning than a complete, trustless account balance:

- It authenticates the commitment list against the root reported by the selected RPC and validates relevant RPC account data.
- It does not authenticate the indexer's encrypted-note availability. The commitment tree does not bind the returned ciphertext bytes. An indexer can supply the correct commitments while withholding or altering ciphertext, causing owned notes to be omitted from the displayed balance.
- RPC replies remain a trust boundary. A genesis-hash check identifies the configured cluster; it is not independent consensus verification and cannot make a malicious RPC trustworthy.
- Results use Solana's `confirmed` commitment where specified by the client. They do not promise finality or eliminate reorganization risk.

For reliable recovery, use an indexer that faithfully reconstructs encrypted outputs from transaction data, and retain operational access to a trusted source of that data. If ciphertext availability is suspect, a fresh trusted synchronization may be necessary; rebuilding from cached commitments alone does not repair omitted note data. Do not treat an unexpectedly low balance as proof that funds were spent.

The SDK does not send a list of successfully decrypted notes to the indexer. However, spent checks send owned-nullifier PDA addresses to the selected RPC. A provider can associate those lookups with each other, their timing, and request metadata. The API, RPC, relayer, and artifact host can also observe network metadata. Choose these providers according to the application's privacy requirements; zero-knowledge proofs do not hide all network activity.

## Proving and artifacts

The default prover uses local `snarkjs` Groth16 proving and pinned zkPay WASM/zkey bytes. Both supplied bytes and downloaded artifacts must match immutable expected sizes and SHA-256 hashes. Verified bytes are copied into private memory and passed directly to the prover; a URL is not fetched again after verification. The official artifact download script verifies the full set before writing files.

These integrity checks detect mismatched artifacts relative to this SDK release. They do not independently audit the circuit, trusted setup, npm dependencies, or release provenance. Do not substitute Privacy Cash artifacts or a different circuit's proving key. Updating protocol artifacts requires an intentional reviewed release, not a caller-provided hash override.

The provider validates proof encoding, coordinate ranges, and binding of all seven public signals to the submitted witness. It does not implement a new verifier or run the pairing check on every proof. The Solana program performs mathematical proof verification. The opt-in real-proof test additionally calls the native `snarkjs.groth16.verify` API in an isolated child process.

A custom `ProofProvider` receives the complete private witness, including spend secrets. Only inject a trusted local implementation. A remote prover, telemetry wrapper, or logging adapter can compromise privacy and spending authority. Private proof errors are replaced with generic messages without a nested witness-bearing cause.

Artifact download cancellation and deadlines cover network I/O. Cancellation is checked around CPU work but cannot interrupt already-running `snarkjs` WASM. For hard CPU cancellation, integrate an application-managed worker and terminate that worker explicitly.

## Payments and uncertain outcomes

Preparation does not broadcast. Submission methods and convenience `deposit`/`send` methods can move funds. A withdrawal's amount is gross, inclusive of its fee. Review the recipient, network, program, gross debit, fee, and net amount before submitting. The client rechecks relevant policy and spent inputs; the chain is the final arbiter.

Persist the intent before submission, then persist any returned signature/status. Payment intents contain no spending key or private witness, but they link recipients, amounts, commitments, and nullifiers. Store them privately and do not publish them to logs or analytics.

Each SDK-generated `PaymentIntent` includes `authentication`, a 64-character lowercase hexadecimal HMAC-SHA256 tag. Its key is derived from the spending secret with SHA-256 and the domain `zkpay/sdk/payment-intent-key/v1`. The MAC covers the intent ID, kind, network, program, root, gross amount, fee, recipient, input nullifiers, and output commitments. Persist this field unchanged; applications do not need to calculate it. It binds recovery metadata to the original wallet/network/signing-host context and prevents altered metadata from being treated as that account's confirmed payment.

Before unlock, `resumePayment` can only check the record's shape and configured pool identity, then retain it provisionally. Unlock authenticates a retained intent with the current spending key, and payment-status checks require and verify that authentication. Acceptance by `resumePayment` while locked is not an authenticity verdict. Missing or invalid authentication must not be repaired by deleting the field, regenerating an intent, or bypassing recovery checks.

The outer `status` and optional `signature` are not covered by the intent MAC. They are untrusted tracking hints. In particular, an error for a restored signature does not establish payment failure. The client returns a definite deposit `failed` result only when it has the matching transaction signature from a transaction signed locally in that live client and the RPC reports the supported confirmed/finalized failure condition. That local signature association does not survive a restart; restored records remain unresolved until trustworthy effects establish the outcome.

An HTTP error, cancellation, missing signature, indexer delay, or confirmation timeout does not prove non-submission. On `SubmissionUnknownError`, preserve `error.payment`. Restore it with `resumePayment` after a restart and perform status checks only. Do not call a submit or prepare method again as an automatic recovery action. An unresolved payment intentionally prevents further preparation in the same client; creating another client does not resolve the original transaction.

`submitted` acknowledges a submission path, not settlement. `confirmed` reflects independently checked pool effects against the selected RPC; it is not a guarantee of finalized consensus. An uncertain withdrawal may remain unresolved when the relayer supplied no reliable signature. Escalate persistent uncertainty for operational investigation instead of guessing that it failed.

The client serializes its own operations, but it does not coordinate separate clients, processes, browser tabs, or machines. Applications must coordinate use of one private account across those boundaries.

## Storage and browser integration

The optional pool cache stores public commitment/ciphertext records only and is namespaced by protocol version, network, genesis hash, program, and API URL. Including the API URL keeps data from different indexers separate. The RPC URL is intentionally excluded because it may contain credentials in its query string. This cache is not a private-key backup or proof of ciphertext authenticity. A custom storage adapter should replace each complete snapshot atomically. Never add decrypted notes or keys to this cache.

Third-party browser origins must not assume the official API permits CORS. Use a controlled backend proxy or compatible self-hosted API. Keep wallet signatures and witnesses in the browser; an API proxy needs only the normal public indexer/relay payloads. Do not use an unrestricted public CORS proxy. Configure the RPC independently; an API-advertised RPC URL does not replace the caller's connection.

Initialize browser WASM explicitly with the selected bundler's supported loading mechanism. This repository does not promise that a bundler copies dependency WASM files automatically. Review dependency and Content Security Policy requirements in the host application.

## Reporting a security issue

Do not post private keys, signatures, decrypted notes, witnesses, funded reproduction steps, or exploitable details in a public issue. Use the repository's private vulnerability reporting feature if it is enabled. Otherwise contact the repository owner through an already authenticated private channel to arrange disclosure before sharing sensitive details. This repository does not currently designate a public security email address or promise a response SLA.

Provide the commit/package version, runtime, affected API, network, and a minimal synthetic reproduction. Do not test against other users' funds or execute a live-money reproduction without explicit authorization.
