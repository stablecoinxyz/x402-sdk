/**
 * x402 Solana client example
 *
 * Calls an x402-gated endpoint using the @stablecoin.xyz/x402 SDK.
 * Signs Ed25519 payments from a Solana keypair.
 *
 * Usage:
 *   npx tsx --env-file=.env client.ts [url]
 *
 * Defaults to http://localhost:4402/premium (the express-server example).
 */

import bs58 from "bs58";
import { createSolanaX402Client, rawKeypairSigner } from "@stablecoin.xyz/x402/solana";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY env var required (base58-encoded Solana private key)");
  process.exit(1);
}

const TARGET_URL = process.argv[2] || "http://localhost:4402/premium";
const API_KEY = process.env.API_KEY; // required for Solana mainnet — get at dashboard.stablecoin.xyz

// Decode base58 private key (64-byte keypair or 32-byte seed)
const secretKey = bs58.decode(PRIVATE_KEY);
const signer = rawKeypairSigner(secretKey);

console.log(`Wallet: ${signer.publicKey}`);
console.log(`Target: ${TARGET_URL}`);
console.log();

const client = createSolanaX402Client({
  signer,
  network: "solana",
  apiKey: API_KEY,
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
