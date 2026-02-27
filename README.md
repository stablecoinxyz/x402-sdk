# @stablecoin.xyz/x402

SDK for the [x402 HTTP payment protocol](https://x402.org) — gate your API behind micropayments, or pay for x402-gated APIs, using [SBC stablecoin](https://stablecoin.xyz).

**No wallet infrastructure to run.** Payments settle through the hosted facilitator at `https://x402.stablecoin.xyz`.

---

## How it works

1. Client makes a normal HTTP request
2. Server returns `402 Payment Required` with amount + recipient
3. Client signs a payment authorization (off-chain) and retries with a `PAYMENT-SIGNATURE` header
4. Server verifies + settles via the facilitator — tokens flow payer → merchant
5. Server returns the gated content

The facilitator never holds funds. EVM uses ERC-2612 Permit (no pre-approval). Solana uses Ed25519 delegation (one-time `approve` required — [see below](#solana-payments)).

---

## Install

```bash
npm install @stablecoin.xyz/x402
```

Install the peer dep for your chain:

```bash
# EVM (Base, Radius)
npm install viem

# Solana
npm install @solana/web3.js @solana/spl-token

# React hook
npm install react
```

---

## Quickstart

### I'm building a server (gate an API)

**Express:**

```typescript
import { x402Middleware } from '@stablecoin.xyz/x402/middleware/express'

app.get(
  '/premium',
  x402Middleware({
    payTo: '0xYourAddress',
    amount: '1000000000000000', // 0.001 SBC — see token amounts below
    network: 'base',
  }),
  handler
)
```

**Next.js App Router:**

```typescript
import { withX402 } from '@stablecoin.xyz/x402/middleware/nextjs'

export const GET = withX402(
  { payTo: '0xYourAddress', amount: '1000000000000000', network: 'base' },
  async (req) => Response.json({ data: 'premium content' })
)
```

**Accept EVM + Solana (multi-network):**

```typescript
x402Middleware([
  { payTo: '0xYourEvmAddress',     amount: '1000000000000000', network: 'base' },
  { payTo: 'YourSolanaAddress',    amount: '1000000',          network: 'solana' },
])
```

---

### I'm building a client (pay for an API)

**EVM (Node.js / browser):**

```typescript
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createX402Client, viemSignerAdapter } from '@stablecoin.xyz/x402/evm'

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
})

const client = createX402Client({
  signer: viemSignerAdapter(walletClient),
})

const res = await client.fetch('https://api.example.com/premium')
const data = await res.json()

// Payment metadata attached to the response
console.log(res.paymentResult)
// { success: true, txHash: '0x...', amountPaid: '1000000000000000', network: 'base' }
```

**React hook:**

```typescript
import { useX402, viemSignerAdapter } from '@stablecoin.xyz/x402/react'

function MyComponent({ walletClient }) {
  const { fetch, paying, lastPayment } = useX402({
    signer: walletClient ? viemSignerAdapter(walletClient) : null,
    network: 'base',
  })

  return (
    <button onClick={() => fetch('https://api.example.com/premium')}>
      {paying ? 'Paying...' : 'Get Premium'}
    </button>
  )
}
```

**Solana:**

```typescript
import { createSolanaX402Client, keypairSignerAdapter } from '@stablecoin.xyz/x402/solana'

const client = createSolanaX402Client({
  signer: keypairSignerAdapter(keypair),
  network: 'solana',
})

const res = await client.fetch('https://api.example.com/premium')
```

> **One-time setup required for Solana** — see [Solana payments](#solana-payments).

---

## Token amounts

Amounts are in atomic units (no decimals). SBC has different precision per chain:

| Network | Decimals | `1.0 SBC` | `0.001 SBC` |
|---------|----------|-----------|-------------|
| `base` | 18 | `1000000000000000000` | `1000000000000000` |
| `base-sepolia` | 6 | `1000000` | `1000` |
| `solana` | 9 | `1000000000` | `1000000` |

---

## Supported networks

| Network key | Chain | Notes |
|-------------|-------|-------|
| `base` | Base mainnet | SBC: `0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798` |
| `base-sepolia` | Base Sepolia | SBC: `0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16` — free test tokens |
| `radius` | Radius mainnet | |
| `radius-testnet` | Radius testnet | |
| `solana` | Solana mainnet | SBC: `DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA` |
| `solana-devnet` | Solana devnet | Free test tokens |

**Testing on testnet:** Use `base-sepolia` for EVM or `solana-devnet` for Solana — amounts are in the smaller denomination and you can get free tokens from a faucet.

---

## Solana payments

Solana's SPL Token program requires the payer to pre-authorize the facilitator as a delegate before it can move tokens on their behalf. This is a one-time on-chain transaction per wallet.

```bash
cd examples/solana-demo
pnpm approve   # runs approve-delegate.ts
```

Or integrate into your own onboarding:

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress, approve } from '@solana/spl-token'

const FACILITATOR = new PublicKey('2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K')
const SBC_MINT    = new PublicKey('DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA')

const tokenAccount = await getAssociatedTokenAddress(SBC_MINT, payer.publicKey)
await approve(connection, payer, tokenAccount, FACILITATOR, payer, BigInt(1_000 * 1e9))
```

---

## API reference

### `createX402Client(options)` — `/evm`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `signer` | `EvmSigner` | required | `viemSignerAdapter(wc)` or `ethersSignerAdapter(s)` |
| `network` | `string` | auto | Preferred network — auto-selected from 402 response if omitted |
| `facilitatorUrl` | `string` | hosted | Override the facilitator endpoint |
| `rpcUrl` | `string` | network default | Override RPC for balance/nonce checks |
| `skipBalanceCheck` | `boolean` | `false` | Skip pre-flight balance check |

### `client.fetch(url, init?)`

Drop-in for `fetch`. Returns `Response & { paymentResult? }`.

```typescript
type PaymentResult = {
  success: boolean
  txHash?: string
  amountPaid?: string
  network?: string
  error?: string
}
```

### `x402Middleware(options | options[])` — `/middleware/express`
### `withX402(options | options[], handler)` — `/middleware/nextjs`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `payTo` | `string` | required | Recipient address |
| `amount` | `string` | required | Amount in atomic units |
| `network` | `string` | required | Network key (e.g. `'base'`) |
| `asset` | `string` | network SBC | Override token contract address |
| `facilitatorUrl` | `string` | hosted | Override facilitator endpoint |
| `settle` | `boolean` | `true` | Set `false` to verify-only (skip on-chain settlement) |

### Signer adapters — `/evm`

```typescript
import { viemSignerAdapter, ethersSignerAdapter } from '@stablecoin.xyz/x402/evm'

viemSignerAdapter(walletClient)   // viem WalletClient
ethersSignerAdapter(signer)       // ethers.js v5/v6 Signer
```

---

## Subpath imports

| Import path | Contents |
|-------------|----------|
| `@stablecoin.xyz/x402` | Core types, errors, network config |
| `@stablecoin.xyz/x402/evm` | `createX402Client`, signer adapters |
| `@stablecoin.xyz/x402/solana` | `createSolanaX402Client`, signer adapters |
| `@stablecoin.xyz/x402/middleware/express` | `x402Middleware` |
| `@stablecoin.xyz/x402/middleware/nextjs` | `withX402` |
| `@stablecoin.xyz/x402/react` | `useX402` hook |

---

## Examples

Runnable end-to-end examples in [`examples/`](./examples/README.md):

```bash
# Terminal 1 — server (accepts EVM + Solana)
cd examples/express-server && cp .env.example .env && pnpm install && pnpm start

# Terminal 2 — EVM client
cd examples/evm-demo && cp .env.example .env && pnpm install && pnpm start

# Terminal 2 — Solana client (run pnpm approve first)
cd examples/solana-demo && cp .env.example .env && pnpm install && pnpm approve && pnpm start
```

---

## License

MIT
