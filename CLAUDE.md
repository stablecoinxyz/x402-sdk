# @stablecoin.xyz/x402 SDK

## Vault Integration

**Status:** `VAULT/Projects/x402-SDK.md`
**Progress:** `VAULT/Projects/PROGRESS.md`

## Role

Developer-facing npm package for the x402 HTTP payment protocol.
Enables apps to pay for APIs and gate their own APIs with SBC stablecoin payments.

## Package Details

- **npm name:** `@stablecoin.xyz/x402`
- **Repo:** `~/code/sbc/x402-sdk/`
- **Publish:** `pnpm publish --access public`

## Architecture

```
src/
├── core/          # Protocol types, network config, facilitator client, retry, errors
├── evm/           # EVM signing (viem/ethers adapters, permit, SBC payment, EIP-3009)
├── solana/        # Solana signing (keypair/wallet-adapter, Ed25519)
├── middleware/    # Server-side: Express + Next.js App Router
└── react/         # useX402 hook
```

## Key Design Decisions

- **No ethers/viem in production bundle** — EvmSigner interface + adapters, external peer dep
- **Raw eth_call for permit nonce** — no viem PublicClient needed in evm/
- **Static SUPPORTED_NETWORKS** — no `process.env` at module load (unlike mcp-server)
- **splitting: true in tsup** — core/ internals deduplicated across all 5 subpath bundles
- **Middleware is verification-only** — no signing, just validate incoming payment headers

## Subpath Entries

| Import | Entry |
|--------|-------|
| `@stablecoin.xyz/x402` | Core types, errors, facilitator |
| `@stablecoin.xyz/x402/evm` | createX402Client, viemSignerAdapter, ethersSignerAdapter |
| `@stablecoin.xyz/x402/solana` | createSolanaX402Client, keypairSignerAdapter |
| `@stablecoin.xyz/x402/middleware` | x402Middleware (Express), withX402 (Next.js) |
| `@stablecoin.xyz/x402/react` | useX402 hook |

## Commands

```bash
pnpm install        # Install dependencies
pnpm build          # Build all subpaths (tsup)
pnpm typecheck      # TypeScript check without building
pnpm test           # Run unit tests (vitest)
pnpm dev            # Watch mode
```

## Supported Networks

| Key | Chain | Facilitator |
|-----|-------|-------------|
| `base` | Base mainnet (8453) | https://x402.stablecoin.xyz (`0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6`) |
| `base-sepolia` | Base Sepolia (84532) | https://x402.stablecoin.xyz |
| `radius` | Radius (723) | https://x402.stablecoin.xyz |
| `radius-testnet` | Radius testnet (72344) | https://x402-testnet.stablecoin.xyz |
| `solana` | Solana mainnet | https://x402.stablecoin.xyz |
| `solana-devnet` | Solana devnet | https://x402-testnet.stablecoin.xyz |

## Related

- Facilitator: `~/code/sbc/x402-facilitator/`
- MCP server (source for ported logic): `~/code/sbc/x402-mcp-server/`
- Demo: `~/code/sbc/x402-demo/`

## Session Start Protocol

1. Read `VAULT/Projects/PROGRESS.md` for current SDK status
2. Check `VAULT/Projects/x402-SDK.md` for open issues
3. Read `src/core/types.ts` for current protocol types before changing anything
