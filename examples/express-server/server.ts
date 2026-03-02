/**
 * x402 Express server example
 *
 * Gates /premium behind x402 payment using @stablecoin.xyz/x402/middleware.
 * Supports single or multi-network (Base + Radius + Solana).
 *
 * Usage:
 *   npx tsx --env-file=.env server.ts
 */

import express from "express";
import { x402Middleware, type X402MiddlewareOptions } from "@stablecoin.xyz/x402/middleware/express";
import { getNetworkConfig } from "@stablecoin.xyz/x402";

// Base (default EVM network)
const BASE_PAY_TO = process.env.BASE_PAY_TO || process.env.PAY_TO || "0xbb46c0c1792d7b606db07cead656efd93b433222";
const BASE_AMOUNT = process.env.BASE_AMOUNT || process.env.AMOUNT || "1000000000000000"; // 0.001 SBC (18 decimals)
const BASE_NETWORK = process.env.BASE_NETWORK || process.env.NETWORK || "base";
const PORT = process.env.PORT || 4402;
const API_KEY = process.env.API_KEY; // required for mainnet — get at dashboard.stablecoin.xyz

// Optional: add Radius payment option
const RADIUS_PAY_TO = process.env.RADIUS_PAY_TO;
const RADIUS_AMOUNT = process.env.RADIUS_AMOUNT || "1000"; // 0.001 SBC on Radius (6 decimals)
const RADIUS_NETWORK = process.env.RADIUS_NETWORK || "radius";

// Optional: add Solana payment option
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO;
const SOLANA_AMOUNT = process.env.SOLANA_AMOUNT || "1000000"; // 0.001 SBC on Solana (9 decimals)
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "solana";

const paymentOptions: X402MiddlewareOptions[] = [
  { payTo: BASE_PAY_TO, amount: BASE_AMOUNT, network: BASE_NETWORK, apiKey: API_KEY },
  ...(RADIUS_PAY_TO
    ? [{ payTo: RADIUS_PAY_TO, amount: RADIUS_AMOUNT, network: RADIUS_NETWORK, apiKey: API_KEY } as X402MiddlewareOptions]
    : []),
  ...(SOLANA_PAY_TO
    ? [{ payTo: SOLANA_PAY_TO, amount: SOLANA_AMOUNT, network: SOLANA_NETWORK, apiKey: API_KEY } as X402MiddlewareOptions]
    : []),
];

const app = express();

app.get("/free", (_req, res) => {
  res.json({ data: "anyone can access this", tier: "free" });
});

app.get(
  "/premium",
  x402Middleware(paymentOptions.length === 1 ? paymentOptions[0] : paymentOptions),
  (_req, res) => {
    res.json({
      data: "exclusive content — you paid for this",
      tier: "premium",
      ts: new Date().toISOString(),
    });
  }
);

app.get("/health", (_req, res) => res.json({ ok: true }));

function formatAmount(raw: string, network: string): string {
  const { decimals } = getNetworkConfig(network);
  const str = raw.padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals) || "0";
  const frac = str.slice(str.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

app.listen(PORT, () => {
  console.log(`x402 Express server on http://localhost:${PORT}`);
  paymentOptions.forEach((opt) => {
    const human = formatAmount(String(opt.amount), String(opt.network));
    console.log(`  [${opt.network}] payTo: ${opt.payTo}, amount: ${human} SBC`);
  });
});
