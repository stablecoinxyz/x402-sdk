/**
 * x402 EVM client example
 *
 * Calls a live x402-gated endpoint using the @stablecoin.xyz/x402 SDK.
 * Uses a viem WalletClient with a private key to sign ERC-2612 Permit payments.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx client.ts [url]
 *
 * Defaults to http://localhost:4402/premium (the express-server example).
 * Optionally point at any x402-gated URL.
 *
 * Requirements:
 *   - Wallet must hold SBC on Base mainnet (or base-sepolia if using test config)
 *   - For base mainnet: SBC token 0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798 (18 decimals)
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createX402Client, viemSignerAdapter, type EvmSigner } from "../../src/evm/index.js";

// ---- Config ----
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY env var required");
  console.error("  PRIVATE_KEY=0x... npx tsx client.ts");
  process.exit(1);
}

const TARGET_URL = process.argv[2] || "http://localhost:4402/premium";
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const FACILITATOR_URL = process.env.FACILITATOR_URL; // undefined = SDK default from network config

// ---- Setup ----
const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Wallet:      ${account.address}`);
console.log(`Target:      ${TARGET_URL}`);
console.log(`RPC:         ${RPC_URL}`);
console.log(`Facilitator: ${FACILITATOR_URL}`);
console.log();

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(RPC_URL),
});

// Debug: wrap fetch to log all outbound calls
const debugFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input as Request).url);
  console.log(`[fetch] ${init?.method ?? "GET"} ${url}`);
  if (url.endsWith("/supported") || url.endsWith("/verify") || url.endsWith("/settle")) {
    const res = await fetch(input, init);
    const clone = res.clone();
    const body = await clone.json().catch(() => null);
    console.log(`[fetch] → ${res.status}`, JSON.stringify(body));
    return res;
  }
  return fetch(input, init);
};

const baseSigner = viemSignerAdapter(walletClient);
const debugSigner: EvmSigner = {
  address: baseSigner.address,
  signTypedData: async (params) => {
    const spender = (params.message as Record<string, unknown>)?.spender;
    console.log(`[signer] signTypedData primaryType=${params.primaryType} spender=${spender}`);
    return baseSigner.signTypedData(params);
  },
};

const client = createX402Client({
  signer: debugSigner,
  rpcUrl: RPC_URL,
  facilitatorUrl: FACILITATOR_URL,
  fetchFn: debugFetch,
});

// ---- Test 1: free endpoint (no payment) ----
console.log("--- GET /free (no payment) ---");
try {
  const freeRes = await fetch(TARGET_URL.replace("/premium", "/free"));
  const freeData = await freeRes.json();
  console.log(`Status: ${freeRes.status}`);
  console.log("Body:", freeData);
} catch {
  console.log("Skipping /free test (local server may not be running)");
}

console.log();

// ---- Test 2: premium endpoint with x402 payment ----
console.log("--- GET /premium (x402 payment) ---");

const res = await client.fetch(TARGET_URL);
const body = await res.json();

console.log(`Status:  ${res.status}`);
console.log("Body:   ", body);

if (res.paymentResult) {
  console.log();
  console.log("Payment result:");
  console.log(`  success   : ${res.paymentResult.success}`);
  console.log(`  txHash    : ${res.paymentResult.txHash}`);
  console.log(`  network   : ${res.paymentResult.network}`);
  console.log(`  amountPaid: ${res.paymentResult.amountPaid}`);
}
