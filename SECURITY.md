# Security

This SDK is experimental and has not received an independent security audit.
Automated tests are not an audit of the SDK, its dependencies or the deployed
program. Solana Mainnet uses real funds; Devnet uses test SOL.

Never put private keys, wallet unlock signatures, access tokens, or decrypted
notes in issues, logs, analytics, screenshots or commits. A wallet unlock
signature can derive the corresponding private spending key. Only sign messages
for applications you trust; copied signing text alone does not authenticate a
website.

The SDK must keep proofs and private witnesses local, pin deployed protocol
identities and proving-artifact hashes, validate external data, use integer
amounts, and distinguish pending/unknown submissions from confirmed payments.
Requests that might have reached the network must not be blindly retried as new
payments.

Security-sensitive issues should be reported using GitHub's private vulnerability
reporting for this repository if enabled. Do not publish exploit details or
secrets in a public issue; ask the maintainer for a private channel if needed.
