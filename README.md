# @stablecoin.xyz/x402

SDK for the [x402 HTTP payment protocol](https://x402.org) using SBC stablecoin.

Gate your API behind micropayments, or pay for x402-gated APIs — in a few lines of code.

## Install

```bash
npm install @stablecoin.xyz/x402
# or
pnpm add @stablecoin.xyz/x402
```

## Quickstart

### Client — pay for a gated API (EVM)

```typescript
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createX402Client, viemSignerAdapter } from '@stablecoin.xyz/x402/evm'

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY),
  chain: base,
  transport: http(),
})

const client = createX402Client({
  signer: viemSignerAdapter(walletClient),
})

const res = await client.fetch('https://api.example.com/premium')
const data = await res.json()

console.log(res.paymentResult) // { success, txHash, amountPaid, network }
```

### Server — gate an Express route

```typescript
import express from 'express'
import { x402Middleware } from '@stablecoin.xyz/x402/middleware/express'

const app = express()

app.get(
  '/premium',
  x402Middleware({
    payTo: '0xYourWalletAddress',
    amount: '1000000000000000', // 0.001 SBC (18 decimals)
    network: 'base',
  }),
  (req, res) => {
    res.json({ data: 'premium content' })
  }
)
```

### Server — gate a Next.js App Router route

```typescript
import { withX402 } from '@stablecoin.xyz/x402/middleware/nextjs'

export const GET = withX402(
  {
    payTo: '0xYourWalletAddress',
    amount: '1000000000000000',
    network: 'base',
  },
  async (req) => {
    return Response.json({ data: 'premium content' })
  }
)
```

### React hook

```typescript
import { useX402 } from '@stablecoin.xyz/x402/react'
import { viemSignerAdapter } from '@stablecoin.xyz/x402/evm'

function MyComponent() {
  const { fetch, paying, lastPayment } = useX402({
    signer: viemSignerAdapter(walletClient),
    network: 'base',
  })

  const handleClick = async () => {
    const res = await fetch('https://api.example.com/premium')
    const data = await res.json()
  }

  return <button onClick={handleClick}>{paying ? 'Paying...' : 'Get Premium'}</button>
}
```

## Subpath imports

| Import | Use |
|--------|-----|
| `@stablecoin.xyz/x402` | Core types, errors, network config |
| `@stablecoin.xyz/x402/evm` | EVM client + signer adapters |
| `@stablecoin.xyz/x402/solana` | Solana client + signer adapters |
| `@stablecoin.xyz/x402/middleware/express` | Express middleware |
| `@stablecoin.xyz/x402/middleware/nextjs` | Next.js App Router middleware |
| `@stablecoin.xyz/x402/react` | `useX402` React hook |

## Supported networks

| Network | Chain | Token |
|---------|-------|-------|
| `base` | Base mainnet | SBC (18 decimals) |
| `base-sepolia` | Base Sepolia testnet | SBC (6 decimals) |
| `radius` | Radius mainnet | SBC |
| `radius-testnet` | Radius testnet | SBC |
| `solana` | Solana mainnet | SBC |
| `solana-devnet` | Solana devnet | SBC |

## API

### `createX402Client(options)` — `/evm`

| Option | Type | Description |
|--------|------|-------------|
| `signer` | `EvmSigner` | Required. Use `viemSignerAdapter(walletClient)` or `ethersSignerAdapter(signer)` |
| `network` | `string` | Preferred network (default: auto-selected from 402 response) |
| `facilitatorUrl` | `string` | Override facilitator URL |
| `rpcUrl` | `string` | Override RPC URL for balance/nonce checks |
| `skipBalanceCheck` | `boolean` | Skip pre-flight balance check (default: `false`) |

### `client.fetch(url, options?)`

Drop-in for `fetch`. Returns `Response & { paymentResult? }` — the response from the gated API after payment, with payment metadata attached.

### `x402Middleware(options)` — `/middleware`

| Option | Type | Description |
|--------|------|-------------|
| `payTo` | `string` | Recipient address |
| `amount` | `string` | Amount in atomic units |
| `network` | `string` | Network to accept payment on |
| `asset` | `string` | Token contract address (default: network's SBC token) |
| `facilitatorUrl` | `string` | Override facilitator URL |
| `settle` | `boolean` | Settle on-chain (default: `true`) |

### Signer adapters

```typescript
import { viemSignerAdapter, ethersSignerAdapter } from '@stablecoin.xyz/x402/evm'

// viem WalletClient
const signer = viemSignerAdapter(walletClient)

// ethers.js Signer
const signer = ethersSignerAdapter(ethersSigner)
```

### Solana

```typescript
import { createSolanaX402Client, keypairSignerAdapter } from '@stablecoin.xyz/x402/solana'

const client = createSolanaX402Client({
  signer: keypairSignerAdapter(keypair),
  network: 'solana',
})

const res = await client.fetch('https://api.example.com/premium')
```

## How it works

1. Client makes a normal HTTP request
2. Server responds with `402 Payment Required` + payment requirements
3. Client signs an ERC-2612 Permit (EVM) or Ed25519 message (Solana) — no pre-approval needed
4. Client re-sends the request with a `PAYMENT-SIGNATURE` header
5. Server verifies + settles the payment via the x402 facilitator
6. Server responds with the gated content + `PAYMENT-RESPONSE` header containing the tx hash

Payment flows directly payer → merchant. The facilitator never holds funds.

## Examples

### Express server

```bash
cd examples/express-server
cp .env.example .env   # set PAY_TO, NETWORK, PORT
pnpm install
pnpm start
```

### EVM client

```bash
cd examples/evm-demo
cp .env.example .env   # set PRIVATE_KEY
pnpm install
pnpm start [target-url]   # default: http://localhost:4402/premium
```

### Solana client

```bash
cd examples/solana-demo
cp .env.example .env   # set PRIVATE_KEY (base58 Solana keypair)
pnpm install
pnpm start [target-url]   # default: http://localhost:4402/premium
```

## License

MIT
