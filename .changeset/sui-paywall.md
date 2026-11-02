---
"@stablecoin.xyz/x402": minor
---

`paywall` (Express and Next.js) accepts Sui: `network: "sui"` or `"sui-testnet"`, priced in native USDC (6 decimals). The 402 offer uses CAIP-2 `network` (`sui:mainnet` / `sui:testnet`), `amount` and `extra: {}`, the shape the SBC facilitator settles. A Sui `payTo` must be a full address (`0x` + 64 hex) and `amount` a positive integer, checked when `paywall()` is called; `settle: false` is refused on Sui, and a Sui payment is matched to the offer whose asset, `payTo` and amount it echoes. Once a Sui transaction may have been broadcast the middleware no longer answers 402: `settlement_pending` returns 202 with the digest, `duplicate_settlement` returns 409 with the digest, and a failed settle call returns 504; the handler does not run in any of these. EVM and Solana offers are unchanged. There is no Sui buyer client.
