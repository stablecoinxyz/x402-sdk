import express from "express";
import { x402Middleware } from "../../src/middleware/index.js";

// --- Config ---
const PAY_TO = process.env.PAY_TO || "0xbb46c0c1792d7b606db07cead656efd93b433222";
const AMOUNT = process.env.AMOUNT || "1000000000000000"; // 0.001 SBC (18 decimals)
const NETWORK = process.env.NETWORK || "base";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://sbc-x402-facilitator.fly.dev";

const app = express();

// ---- Free endpoint ----
app.get("/free", (_req, res) => {
  res.json({ data: "anyone can access this", tier: "free" });
});

// ---- Premium endpoint (gated) ----
app.get(
  "/premium",
  x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: FACILITATOR_URL }),
  (_req, res) => {
    res.json({
      data: "exclusive content — you paid for this",
      tier: "premium",
      ts: new Date().toISOString(),
    });
  },
);

// ---- Health ----
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4402;
app.listen(PORT, () => {
  console.log(`x402 Express example running on http://localhost:${PORT}`);
  console.log(`  GET /free    — no payment required`);
  console.log(`  GET /premium — requires x402 payment`);
  console.log(`  GET /health  — health check`);
  console.log();
  console.log(`Payment config:`);
  console.log(`  network : ${NETWORK}`);
  console.log(`  payTo   : ${PAY_TO}`);
  console.log(`  amount  : ${AMOUNT} ($${Number(AMOUNT) / 10 ** 18})`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);;
});
