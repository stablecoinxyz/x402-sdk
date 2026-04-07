# x402 SDK Examples

Four examples to manually verify the SDK end-to-end:

1. **express-server** — Express API gated with `paywall` (Base + Radius + Solana)
2. **base-demo** — Base client (ERC-2612 Permit — no pre-approval needed)
3. **radius-demo** — Radius client (ERC-2612 Permit — no pre-approval needed)
4. **solana-demo** — Solana client (Ed25519 signature — requires one-time delegate approval)

---

## Quick start

### 1. Start the express server

```bash
cd express-server
cp .env.example .env
# Set BASE_PAY_TO, and optionally RADIUS_PAY_TO / SOLANA_PAY_TO
pnpm install
pnpm start
```

Endpoints:
- `GET /free` — no payment required
- `GET /premium` — x402 gated
- `GET /health` — health check

The server advertises all configured networks in the `accepts[]` array of the 402 response. Base is always enabled. Set `RADIUS_PAY_TO` and/or `SOLANA_PAY_TO` to accept additional networks.

---

### 2a. Run the Base client

```bash
cd base-demo
cp .env.example .env
# Set PRIVATE_KEY=0x... (wallet must hold SBC on Base mainnet)
pnpm install
pnpm start
```

No setup beyond a funded wallet. ERC-2612 Permit is signed off-chain — no on-chain approval transaction needed.

**Requirements:**
- Wallet holds SBC on Base mainnet (`0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798`, 18 decimals)

---

### 2b. Run the Radius client

```bash
cd radius-demo
cp .env.example .env
# Set PRIVATE_KEY=0x... and RPC_URL (wallet must hold SBC on Radius)
pnpm install
pnpm start
```

Same Permit-based flow as Base — no on-chain approval needed.

**Requirements:**
- Wallet holds SBC on Radius (chain ID 723487)
- `RPC_URL` env var set to a Radius RPC endpoint

---

### 2c. Run the Solana client

```bash
cd solana-demo
cp .env.example .env
# Set PRIVATE_KEY=... (base58 Solana keypair, must hold SBC on Solana mainnet)
pnpm install
```

**One-time setup — approve the facilitator as delegate:**

```bash
pnpm approve
```

This runs a single `approve` transaction that authorizes the x402 facilitator to transfer SBC tokens on your behalf. Required because SPL Token transfers need pre-delegation (unlike EVM's off-chain Permit). Only needed once per wallet.

Then:

```bash
pnpm start
```

**Requirements:**
- Wallet holds SBC on Solana mainnet (`DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA`)
- Facilitator approved as delegate (run `pnpm approve` once)

---

## Testnet

Change the server's `.env`:
```
BASE_NETWORK=base-sepolia
RADIUS_NETWORK=radius-testnet
SOLANA_NETWORK=solana-devnet
```

The clients use whatever network the server advertises — no client-side changes needed.
