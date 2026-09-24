# zkPay Solana SDK

An independent TypeScript SDK for zkPay's deployed native-SOL privacy pool.
This repository is under active implementation; it is not yet a published npm
package. No npm release or live-money transaction is performed by development
commands.

## Development

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run check
```

Work is delivered in reviewable commits: protocol research and exact amount
handling; cryptographic/wire compatibility; network and wallet integrations;
verified balance sync and payment flows; examples, package validation and tests.

Only SOL deposits and relayed withdrawals are in scope. The currently deployed
program does not accept zero-external-amount in-pool transfers. SPL tokens,
in-pool transfers, automatic fund movement, and npm publication are not implied.

## Repository policy

Never commit wallet keys, unlock signatures, tokens, private RPC URLs or decrypted
notes. Tests use explicitly public deterministic fixtures only. The package is
marked private and has no redistribution license selected pending the owner's
release decision.
