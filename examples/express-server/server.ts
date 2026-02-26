/**
 * x402 Express server example
 *
 * Gates /premium behind x402 payment using @stablecoin.xyz/x402/middleware.
 *
 * Usage:
 *   npx tsx --env-file=.env server.ts
 */

import express from "express";
import { x402Middleware } from "@stablecoin.xyz/x402/middleware";

const PAY_TO = process.env.PAY_TO || "0xbb46c0c1792d7b606db07cead656efd93b433222";
const AMOUNT = process.env.AMOUNT || "1000000000000000"; // 0.001 SBC (18 decimals)
const NETWORK = process.env.NETWORK || "base";
const PORT = process.env.PORT || 4402;

const app = express();

app.get("/free", (_req, res) => {
  res.json({ data: "anyone can access this", tier: "free" });
});

app.get(
  "/premium",
  x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK }),
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
  console.log(`  network : ${NETWORK}`);
  console.log(`  payTo   : ${PAY_TO}`);
  console.log(`  amount  : ${AMOUNT}`);
});
