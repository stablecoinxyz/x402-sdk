---
"@stablecoin.xyz/x402": patch
---

`paywall` maps two Sui settle reasons from the SBC facilitator that were answered with 402: `settlement_effects_mismatch` (the transaction executed but `payTo` was not credited exactly the amount) now returns 409 with the digest, since money moved and the buyer should reconcile rather than pay again; `sui_durability_unavailable` (the facilitator's settlement ledger is down and nothing was submitted) now returns 503. The handler does not run in either case.
