# @stablecoin.xyz/x402

## 0.6.1

### Patch Changes

- 4660190: `paywall` maps two Sui settle reasons from the SBC facilitator that were answered with 402: `settlement_effects_mismatch` (the transaction executed but `payTo` was not credited exactly the amount) now returns 409 with the digest, since money moved and the buyer should reconcile rather than pay again; `sui_durability_unavailable` (the facilitator's settlement ledger is down and nothing was submitted) now returns 503. The handler does not run in either case.

## 0.6.0

### Minor Changes

- 1da27c2: The EVM buyer client (`createX402Client`, and `useX402` through it) now pays with x402 v2 Permit2, the only EVM payload the SBC facilitator settles; it signed ERC-2612 before and could not pay anyone. It signs a Permit2 `PermitWitnessTransferFrom` to the x402 proxy bound to the seller's `payTo`, and, when the payer's Permit2 allowance is below the amount, an ERC-2612 permit approving Permit2 for exactly that amount (sent as the `eip2612GasSponsoring` extension), so no on-chain approval is needed. A standing Permit2 approval is left untouched. The payment echoes the seller's offer in `accepted`. Breaking: an EVM 402 with no `assetTransferMethod: "permit2"` offer (paywall < 0.5) now throws. The seller's `maxTimeoutSeconds` is clamped to 30–600 s. A 202 from the seller is reported as `paymentResult.pending: true` with `success: false`. `facilitatorUrl` is deprecated and unused. Both the EVM and Solana clients now also read the receipt from an x402 v1 `X-PAYMENT-RESPONSE` header. EOA signers only. New exports: `signPermit2Payment`, `PERMIT2_ADDRESS`, `X402_PERMIT2_PROXY`.

## 0.5.1

### Patch Changes

- ef22de8: `paywall` (Express and Next.js) no longer answers 402 on any network once the facilitator may have broadcast the payment. `settlement_pending` now returns 202 with the transaction (it was a 402 carrying the transaction on EVM and Solana), and a settle call that fails returns 504 with `outcome: "unknown"` (it was a 402). Settle is sent once and never retried. A mined-and-reverted settlement is still a 402. Previously a buyer reading the 402 status would sign a fresh payment while the first could still land.

## 0.5.0

### Minor Changes

- d02e576: `paywall` (Express and Next.js) now advertises EVM payment requirements in the x402 v2 Permit2 shape the SBC facilitator accepts: CAIP-2 `network`, `amount`, and `extra: { assetTransferMethod: "permit2", name, version }`, without the ERC-2612 `facilitator` spender. 0.4.1 offers could not be paid by Permit2 buyers. EVM `payTo`, `amount` and `asset` are validated when `paywall()` is called, and an unlisted EVM token needs the new `tokenName` / `tokenVersion` options. The handler's payer now comes from the facilitator's verify response. Solana offers are unchanged. A payment is matched to its offer by network, asset, `payTo` and amount, so several offers on one network work; an EVM payment whose echoed offer differs from the route's is refused locally without a facilitator call. `settle: false` (verify-only) now throws on EVM networks: the facilitator's verify does not consume the Permit2 nonce, so one signed payment would be served without limit. A failed settlement that reports a transaction (`settlement_pending`, `duplicate_settlement`) returns it in the 402 body as `transaction` with `errorReason`, so buyers can check it instead of paying again. Next.js: buyer-sent `x-payment-*` headers are dropped before the handler runs, and a handler error after settlement is no longer turned into a 402. The EVM client now reads CAIP-2 offers and never picks a Solana offer, but it still signs ERC-2612, which the facilitator no longer settles; moving it to Permit2 is separate work.

  Upgrading from 0.4.1: `paywall()` now throws at startup for `settle: false` on EVM, an EVM `payTo` that is not a non-zero 20-byte hex address, an `amount` that is not a positive integer string, an unlisted EVM `asset` without `tokenName`/`tokenVersion`, and token options on a Solana entry. The 402 `network` is now CAIP-2, while `req.x402.network`, the `x-payment-network` header and `PAYMENT-RESPONSE.network` keep the friendly name. EVM offers no longer carry `facilitator`. The handler's payer now comes from the facilitator.

- 68e4b0b: `paywall` (Express and Next.js) accepts Sui: `network: "sui"` or `"sui-testnet"`, priced in native USDC (6 decimals). The 402 offer uses CAIP-2 `network` (`sui:mainnet` / `sui:testnet`), `amount` and `extra: {}`, the shape the SBC facilitator settles. A Sui `payTo` must be a full address (`0x` + 64 hex) and `amount` a positive integer, checked when `paywall()` is called; `settle: false` is refused on Sui, and a Sui payment is matched to the offer whose asset, `payTo` and amount it echoes. Once a Sui transaction may have been broadcast the middleware no longer answers 402: `settlement_pending` returns 202 with the digest, `duplicate_settlement` returns 409 with the digest, a failed settle call returns 504 (a Sui settle is never retried), and a retry whose transaction already executed returns 409 instead of 402; the handler does not run in any of these. EVM and Solana offers are unchanged. There is no Sui buyer client.

## 0.4.0

### Minor Changes

- 1ac20d8: Renamed middleware to paywall, removed deprecated code

## 0.3.2

### Patch Changes

- 6857b8e: Update Radius mainnet chain ID from 723 to 723487

## 0.2.0

### Minor Changes

- 27f0544: Add `apiKey` option for mainnet network access

  All client factories (`createX402Client`, `createSolanaX402Client`), middleware (`x402Middleware`, `withX402`), and the React hook (`useX402`) now accept an `apiKey` option. When provided, the key is sent as an `X-API-Key` header to the facilitator — required for production access to Base, Radius, and Solana mainnet networks.

  Get your API key at dashboard.stablecoin.xyz.

### Patch Changes

- c9dc5a7: Initial public release
