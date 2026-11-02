---
"@stablecoin.xyz/x402": patch
---

`paywall` (Express and Next.js) no longer answers 402 on any network once the facilitator may have broadcast the payment. `settlement_pending` now returns 202 with the transaction (it was a 402 carrying the transaction on EVM and Solana), and a settle call that fails returns 504 with `outcome: "unknown"` (it was a 402). Settle is sent once and never retried. A mined-and-reverted settlement is still a 402. Previously a buyer reading the 402 status would sign a fresh payment while the first could still land.
