/**
 * x402 EVM client example
 *
 * Calls an x402-gated endpoint using the @stablecoin.xyz/x402 SDK.
 * Signs ERC-2612 Permit payments with a viem WalletClient.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx client.ts [url]
 *
 * Or with .env file:
 *   npx tsx --env-file=.env client.ts [url]
 *
 * Defaults to http://localhost:4402/premium (the express-server example).
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createX402Client, viemSignerAdapter } from "@stablecoin.xyz/x402/evm";

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY env var required");
  process.exit(1);
}

const TARGET_URL = process.argv[2] || "http://localhost:4402/premium";
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Wallet: ${account.address}`);
console.log(`Target: ${TARGET_URL}`);
console.log();

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(RPC_URL),
});

const client = createX402Client({
  signer: viemSignerAdapter(walletClient),
  rpcUrl: RPC_URL,
});

// Free endpoint
try {
  const res = await fetch(TARGET_URL.replace("/premium", "/free"));
  console.log("GET /free →", res.status, await res.json());
} catch {
  console.log("GET /free → (server not running)");
}

console.log();

// Premium endpoint — triggers x402 payment
console.log("GET /premium → paying...");
const res = await client.fetch(TARGET_URL);
const body = await res.json();

console.log("Status:", res.status);
console.log("Body:", body);

if (res.paymentResult) {
  console.log();
  console.log("Payment:");
  console.log("  txHash    :", res.paymentResult.txHash);
  console.log("  amountPaid:", res.paymentResult.amountPaid);
  console.log("  network   :", res.paymentResult.network);
}
