/**
 * x402 Express server example
 *
 * Gates /premium behind x402 payment using @stablecoin.xyz/x402/middleware.
 * Supports single or multi-network (EVM + Solana).
 *
 * Usage:
 *   npx tsx --env-file=.env server.ts
 */

import express from "express";
import { x402Middleware, type X402MiddlewareOptions } from "@stablecoin.xyz/x402/middleware/express";

const PAY_TO = process.env.PAY_TO || "0xbb46c0c1792d7b606db07cead656efd93b433222";
const AMOUNT = process.env.AMOUNT || "1000000000000000"; // 0.001 SBC (18 decimals)
const NETWORK = process.env.NETWORK || "base";
const PORT = process.env.PORT || 4402;

// Optional: add Solana payment option if SOLANA_PAY_TO is configured
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO;
const SOLANA_AMOUNT = process.env.SOLANA_AMOUNT || "1000000"; // 0.001 SBC (9 decimals)
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "solana";

const paymentOptions: X402MiddlewareOptions[] = [
  { payTo: PAY_TO, amount: AMOUNT, network: NETWORK },
  ...(SOLANA_PAY_TO
    ? [{ payTo: SOLANA_PAY_TO, amount: SOLANA_AMOUNT, network: SOLANA_NETWORK } as X402MiddlewareOptions]
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

app.listen(PORT, () => {
  console.log(`x402 Express server on http://localhost:${PORT}`);
  paymentOptions.forEach((opt) => {
    console.log(`  [${opt.network}] payTo: ${opt.payTo}, amount: ${opt.amount}`);
  });
});
