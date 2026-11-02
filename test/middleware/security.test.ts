/**
 * Money-path guards from the security review of the Permit2 change.
 */
import { describe, it, expect, vi } from "vitest";
import { x402Middleware } from "../../src/middleware/express.js";
import { withX402 } from "../../src/middleware/nextjs.js";
import { makeFetchResponse, toBase64 } from "../helpers.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const SBC = "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb"; // radius-testnet SBC
const OPTS = { payTo: PAY_TO, amount: "1000", network: "radius-testnet" };
const TX = "0x" + "cd".repeat(32);

function header(accepted: Record<string, unknown>) {
  return toBase64(JSON.stringify({ accepted, payload: { signature: "0x00" } }));
}
const goodAccepted = { scheme: "exact", network: "eip155:72344", asset: SBC, payTo: PAY_TO, amount: "1000" };

function makeRes() {
  let statusCode = 200;
  let jsonBody: any = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(body: unknown) { jsonBody = body; },
    setHeader(name: string, value: string) { headers[name] = value; },
    getHeader(name: string) { return headers[name]; },
    _status: () => statusCode,
    _body: () => jsonBody,
  };
  return res;
}

function facilitator(settle: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    if (url.endsWith("/verify")) return makeFetchResponse(200, { isValid: true, payer: "0x9999999999999999999999999999999999999999" });
    if (url.endsWith("/settle")) return makeFetchResponse(200, settle);
    throw new Error(`Unexpected: ${url}`);
  });
}

describe("verify-only on EVM", () => {
  it("is refused at construction", () => {
    expect(() => x402Middleware({ ...OPTS, settle: false })).toThrow(/verify-only/);
    expect(() => withX402({ ...OPTS, settle: false }, async () => new Response("ok"))).toThrow(/verify-only/);
  });
});

describe("a payment that does not echo this route's offer", () => {
  for (const [label, accepted] of [
    ["lower amount", { ...goodAccepted, amount: "1" }],
    ["other asset", { ...goodAccepted, asset: "0x" + "77".repeat(20) }],
    ["other payTo", { ...goodAccepted, payTo: "0x" + "88".repeat(20) }],
    ["missing amount", { scheme: "exact", network: "eip155:72344", asset: SBC, payTo: PAY_TO }],
  ] as const) {
    it(`is refused locally without a facilitator call: ${label}`, async () => {
      const fn = facilitator({ success: true, transaction: TX });
      const res = makeRes();
      const next = vi.fn();
      await x402Middleware({ ...OPTS, fetchFn: fn })(
        { headers: { "x-payment": header(accepted) }, url: "/p", method: "GET" }, res, next
      );
      expect(res._status()).toBe(402);
      expect(next).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });
  }
});

describe("settlement that may have moved money is never answered 402", () => {
  // The facilitator answers settlement_pending when it broadcast the transfer but could not
  // read the outcome (x402-facilitator src/routes/settle.ts, the settlementPending branch).
  // A 402 there tells the buyer to sign a fresh permit: a second payment if the first lands.
  const pending = { success: false, errorReason: "settlement_pending", transaction: TX };

  it("Express: settlement_pending → 202 with the transaction, handler not run", async () => {
    const res = makeRes();
    const next = vi.fn();
    await x402Middleware({ ...OPTS, fetchFn: facilitator(pending) })(
      { headers: { "x-payment": header(goodAccepted) }, url: "/p", method: "GET" }, res, next
    );
    expect(res._status()).toBe(202);
    expect(res._body()).toMatchObject({ pending: true, reason: "settlement_pending", payment: { txHash: TX } });
    expect(next).not.toHaveBeenCalled();
  });

  it("Next.js: settlement_pending → 202 with the transaction, handler not run", async () => {
    const route = vi.fn(async () => new Response("ok"));
    const handler = withX402({ ...OPTS, fetchFn: facilitator(pending) }, route);
    const res = await handler(new Request("https://a.test/p", { headers: { "x-payment": header(goodAccepted) } }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pending: true, payment: { txHash: TX } });
    expect(route).not.toHaveBeenCalled();
  });

  it("Solana: settlement_pending → 202 as well", async () => {
    const sol = { payTo: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K", amount: "1000", network: "solana-devnet", asset: "So11111111111111111111111111111111111111112" };
    const res = makeRes();
    await x402Middleware({ ...sol, fetchFn: facilitator(pending) })(
      { headers: { "x-payment": header({ scheme: "exact", network: "solana:devnet" }) }, url: "/p", method: "GET" }, res, vi.fn()
    );
    expect(res._status()).toBe(202);
  });

  it("Express: the settle call itself fails → 504 outcome unknown, sent once, handler not run", async () => {
    let settleCalls = 0;
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.endsWith("/verify")) return makeFetchResponse(200, { isValid: true, payer: "0x9999999999999999999999999999999999999999" });
      settleCalls++;
      throw new Error("read ECONNRESET");
    });
    const res = makeRes();
    const next = vi.fn();
    await x402Middleware({ ...OPTS, fetchFn: fn })(
      { headers: { "x-payment": header(goodAccepted) }, url: "/p", method: "GET" }, res, next
    );
    expect(settleCalls).toBe(1);
    expect(res._status()).toBe(504);
    expect(res._body()).toMatchObject({ outcome: "unknown" });
    expect(next).not.toHaveBeenCalled();
  });

  it("Next.js: the settle call itself fails → 504 outcome unknown", async () => {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.endsWith("/verify")) return makeFetchResponse(200, { isValid: true, payer: "0x9999999999999999999999999999999999999999" });
      throw new Error("socket hang up");
    });
    const handler = withX402({ ...OPTS, fetchFn: fn }, async () => new Response("ok"));
    const res = await handler(new Request("https://a.test/p", { headers: { "x-payment": header(goodAccepted) } }));
    expect(res.status).toBe(504);
  });

  it("a mined-and-reverted settlement is a definite no: still 402, with the transaction", async () => {
    const reverted = { success: false, errorReason: "invalid_transaction_state", transaction: TX };
    const res = makeRes();
    await x402Middleware({ ...OPTS, fetchFn: facilitator(reverted) })(
      { headers: { "x-payment": header(goodAccepted) }, url: "/p", method: "GET" }, res, vi.fn()
    );
    expect(res._status()).toBe(402);
    expect(res._body()).toMatchObject({ errorReason: "invalid_transaction_state", transaction: TX });
  });
});

describe("Next.js after settlement", () => {
  it("a handler error is not turned into a 402 that invites a second payment", async () => {
    const fn = facilitator({ success: true, transaction: TX });
    const handler = withX402({ ...OPTS, fetchFn: fn }, async () => {
      throw new Error("handler broke");
    });
    await expect(
      handler(new Request("https://a.test/p", { headers: { "x-payment": header(goodAccepted) } }))
    ).rejects.toThrow("handler broke");
    expect(fn.mock.calls.some((c) => String(c[0]).endsWith("/settle"))).toBe(true);
  });

  it("buyer-sent x-payment-* headers never reach the handler", async () => {
    const fn = facilitator({ success: true }); // settled, but no hash reported
    let seen: Record<string, string | null> = {};
    const handler = withX402({ ...OPTS, fetchFn: fn }, async (req) => {
      seen = { tx: req.headers.get("x-payment-tx"), other: req.headers.get("x-payment-credit") };
      return new Response("ok");
    });
    await handler(new Request("https://a.test/p", {
      headers: { "x-payment": header(goodAccepted), "x-payment-tx": "0xFORGED", "x-payment-credit": "1000000" },
    }));
    expect(seen).toEqual({ tx: null, other: null });
  });
});
