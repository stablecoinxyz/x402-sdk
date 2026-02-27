# @stablecoin.xyz/x402

## 0.2.0

### Minor Changes

- 27f0544: Add `apiKey` option for mainnet network access

  All client factories (`createX402Client`, `createSolanaX402Client`), middleware (`x402Middleware`, `withX402`), and the React hook (`useX402`) now accept an `apiKey` option. When provided, the key is sent as an `X-API-Key` header to the facilitator — required for production access to Base, Radius, and Solana mainnet networks.

  Get your API key at dashboard.stablecoin.xyz.

### Patch Changes

- c9dc5a7: Initial public release
