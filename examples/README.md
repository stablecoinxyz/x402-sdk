# x402 SDK Examples

Two examples to manually verify the SDK end-to-end:

1. **express-server** — Express API gated with `x402Middleware`
2. **node-evm** — Node.js EVM client that pays and fetches

---

## Quick start

### 1. Start the express server

```bash
cd express-server
pnpm install
node server.js
```

Endpoints:
- `GET /free` — no payment
- `GET /premium` — x402 gated (0.01 SBC, Base mainnet)
- `GET /health` — health check

Without a payment header, `/premium` returns a 402 with the full `x402Version:2` requirements body.

---

### 2. Run the EVM client

In a second terminal:

```bash
cd node-evm
pnpm install
PRIVATE_KEY=0x<your-key> node client.js
```

The client will:
1. Hit `/free` with a plain fetch (no payment)
2. Hit `/premium` with `createX402Client` — auto-pays via ERC-2612 Permit, retries the request, prints the `paymentResult`

**Requirements:**
- Wallet must hold SBC on Base mainnet (`0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798`, 18 decimals)
- At least 0.01 SBC needed per request

**Test wallet (from x402-demo .env):**
```
PRIVATE_KEY=0x9ab015818ce61c7d64831474675c108aed4716ce52c49d271eb6fe3f83f0c5b9
```

**Point at a remote URL:**
```bash
PRIVATE_KEY=0x... node client.js https://some-x402-api.example.com/endpoint
```

---

## Switching to Base Sepolia (test tokens)

In `express-server/server.js` change:
```js
const AMOUNT = "10000";                    // 0.01 SBC (6 decimals)
const NETWORK = "base-sepolia";
```

In `node-evm/client.js` change:
```js
import { baseSepolia } from "viem/chains";
// chain: baseSepolia
const RPC_URL = "https://sepolia.base.org";
```
