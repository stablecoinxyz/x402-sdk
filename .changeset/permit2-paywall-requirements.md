---
"@stablecoin.xyz/x402": minor
---

`paywall` (Express and Next.js) now advertises EVM payment requirements in the x402 v2 Permit2 shape the SBC facilitator accepts: CAIP-2 `network`, `amount`, and `extra: { assetTransferMethod: "permit2", name, version }`, without the ERC-2612 `facilitator` spender. 0.4.1 offers could not be paid by Permit2 buyers. EVM `payTo`, `amount` and `asset` are validated when `paywall()` is called, and an unlisted EVM token needs the new `tokenName` / `tokenVersion` options. The handler's payer now comes from the facilitator's verify response. Solana offers are unchanged. The SDK's own EVM buyer client still signs ERC-2612 and is not updated here.
