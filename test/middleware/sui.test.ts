/**
 * Sui seller support: the 402 offer must be one the SBC agent platform will pay and the SBC
 * facilitator will settle, and a settlement whose outcome is not "nothing happened" must never
 * be answered with a 402 (which invites the buyer to sign and pay again).
 *
 * `facilitatorBinds` mirrors `suiAcceptanceBindsRequirements` in x402-facilitator
 * src/sui/sui-exact.ts (network and amount string-equal, asset and payTo equal after
 * normalization). `platformSelects` mirrors `selectSuiRequirement` in agent-payments
 * apps/web/lib/sui-x402.ts. The buyer echoes the whole offer as `accepted`.
 */
import { describe, it, expect, vi } from "vitest";
import { x402Middleware } from "../../src/middleware/express.js";
import { withX402 } from "../../src/middleware/nextjs.js";
import { toCAIP2 } from "../../src/core/networks.js";
import { makeFetchResponse, toBase64, fromBase64 } from "../helpers.js";

const SUI_PAY_TO = "0x" + "ab".repeat(32);
const SUI_BUYER = "0x" + "cd".repeat(32);
const SUI_TESTNET_USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI_MAINNET_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const DIGEST = "9xfWtDxRTNsCB43aGyKq3zMvhGN8M8yrSM7dWwCxAYk6";
const AMOUNT = "10000";

type Json = Record<string, any>;

function facilitatorBinds(accepted: Json, requirements: Json): boolean {
  const norm = (s: string) => s.toLowerCase();
  return (
    typeof accepted.network === "string" && accepted.network === requirements.network &&
    typeof accepted.amount === "string" && accepted.amount === requirements.amount &&
    typeof accepted.asset === "string" && typeof requirements.asset === "string" &&
    norm(accepted.asset) === norm(requirements.asset) &&
    typeof accepted.payTo === "string" && typeof requirements.payTo === "string" &&
    norm(accepted.payTo) === norm(requirements.payTo)
  );
}

function platformSelects(offer: Json, networkId: string, usdc: string): boolean {
  return (
    offer.scheme === "exact" &&
    offer.network === networkId &&
    offer.asset === usdc &&
    typeof offer.amount === "string" && /^[1-9]\d*$/.test(offer.amount) &&
    typeof offer.payTo === "string" && /^0x[0-9a-fA-F]{64}$/.test(offer.payTo) &&
    offer.extra?.feePayer === undefined
  );
}

function makeRes() {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(body: unknown) { jsonBody = body; },
    setHeader(name: string, value: string) { headers[name] = value; },
    getHeader(name: string) { return headers[name]; },
    _status: () => statusCode,
    _body: () => jsonBody as Json,
    _headers: () => headers,
  };
  return res;
}

const suiOpts = (over: Json = {}) => ({ payTo: SUI_PAY_TO, amount: AMOUNT, network: "sui-testnet", ...over });

async function expressOffer(opts: Json): Promise<Json> {
  const res = makeRes();
  await x402Middleware(opts as any)({ headers: {}, url: "/premium", method: "GET" }, res, vi.fn());
  expect(res._status()).toBe(402);
  return JSON.parse(fromBase64(res._headers()["PAYMENT-REQUIRED"])).accepts[0];
}

async function nextOffer(opts: Json): Promise<Json> {
  const route = withX402(opts as any, async () => new Response("ok"));
  const r = await route(new Request("https://seller.example/premium"));
  expect(r.status).toBe(402);
  return JSON.parse(fromBase64(r.headers.get("PAYMENT-REQUIRED")!)).accepts[0];
}

/** The payment header the platform's Sui buyer sends: the offer echoed whole as `accepted`. */
function paymentHeader(offer: Json): string {
  return toBase64(JSON.stringify({
    x402Version: 2,
    resource: "https://seller.example/premium",
    accepted: offer,
    payload: { transaction: "dHg=", signature: "c2ln" },
  }));
}

/** Facilitator mock that records request bodies and applies the binding check. */
function facilitator(settle: Json | (() => never), verify: Json = { isValid: true, payer: SUI_BUYER }) {
  const bodies: Json[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (!facilitatorBinds(body.paymentPayload.accepted, body.paymentRequirements)) {
      return makeFetchResponse(200, url.endsWith("/verify")
        ? { isValid: false, payer: "unknown", invalidReason: "invalid_payload" }
        : { success: false, payer: "unknown", transaction: "", errorReason: "invalid_payload" });
    }
    if (url.endsWith("/verify")) return makeFetchResponse(200, verify);
    if (url.endsWith("/settle")) {
      if (typeof settle === "function") settle();
      return makeFetchResponse(200, settle);
    }
    throw new Error(`Unexpected: ${url}`);
  });
  return { fetchFn, bodies };
}

async function payExpress(settle: Json | (() => never), verify?: Json) {
  const { fetchFn, bodies } = facilitator(settle, verify);
  const offer = await expressOffer(suiOpts());
  const mw = x402Middleware(suiOpts({ fetchFn }) as any);
  const req: Json = { headers: { "x-payment": paymentHeader(offer) }, url: "/premium", method: "GET" };
  const res = makeRes();
  const next = vi.fn();
  await mw(req as any, res, next);
  return { res, next, req, bodies };
}

async function payNext(settle: Json | (() => never), verify?: Json) {
  const { fetchFn, bodies } = facilitator(settle, verify);
  const offer = await nextOffer(suiOpts());
  const handler = vi.fn(async (r: Request) => Response.json({ payer: r.headers.get("x-payment-payer") }));
  const route = withX402(suiOpts({ fetchFn }) as any, handler);
  const res = await route(new Request("https://seller.example/premium", { headers: { "x-payment": paymentHeader(offer) } }));
  return { res, handler, bodies };
}

describe("Sui network IDs", () => {
  it("maps sui and sui-testnet to CAIP-2", () => {
    expect(toCAIP2("sui")).toBe("sui:mainnet");
    expect(toCAIP2("sui-testnet")).toBe("sui:testnet");
  });
});

describe("Sui 402 offer", () => {
  for (const [name, get] of [["express", expressOffer], ["nextjs", nextOffer]] as const) {
    it(`${name}: CAIP-2 network, amount, USDC asset, extra {}, no facilitator`, async () => {
      const offer = await get(suiOpts());
      expect(offer).toMatchObject({
        scheme: "exact",
        network: "sui:testnet",
        amount: AMOUNT,
        payTo: SUI_PAY_TO,
        asset: SUI_TESTNET_USDC,
        maxTimeoutSeconds: 300,
        extra: {},
      });
      expect(offer).not.toHaveProperty("facilitator");
      expect(platformSelects(offer, "sui:testnet", SUI_TESTNET_USDC)).toBe(true);
    });
  }

  it("mainnet offer uses mainnet USDC", async () => {
    const offer = await expressOffer(suiOpts({ network: "sui" }));
    expect(offer.network).toBe("sui:mainnet");
    expect(offer.asset).toBe(SUI_MAINNET_USDC);
    expect(platformSelects(offer, "sui:mainnet", SUI_MAINNET_USDC)).toBe(true);
  });
});

describe("Sui construction-time validation", () => {
  const bad: Array<[string, Json, RegExp]> = [
    ["EVM-length payTo", { payTo: "0x1234567890123456789012345678901234567890" }, /payTo/],
    ["payTo without 0x", { payTo: "ab".repeat(32) }, /payTo/],
    ["zero amount", { amount: "0" }, /amount/],
    ["decimal amount", { amount: "1.5" }, /amount/],
  ];
  it("accepts a valid Sui option", () => {
    expect(() => x402Middleware(suiOpts() as any)).not.toThrow();
    expect(() => withX402(suiOpts() as any, async () => new Response("ok"))).not.toThrow();
  });
  for (const [label, over, msg] of bad) {
    it(`express throws on ${label}`, () => {
      expect(() => x402Middleware(suiOpts(over) as any)).toThrow(msg);
    });
    it(`nextjs throws on ${label}`, () => {
      expect(() => withX402(suiOpts(over) as any, async () => new Response("ok"))).toThrow(msg);
    });
  }
});

describe("Sui verify-only is refused", () => {
  it("settle: false throws at construction (verify consumes nothing, so a payment would replay)", () => {
    expect(() => x402Middleware(suiOpts({ settle: false }) as any)).toThrow(/settle: false/);
    expect(() => withX402(suiOpts({ settle: false }) as any, async () => new Response("ok"))).toThrow(/settle: false/);
  });
});

describe("Sui payment is matched to the offer it echoes", () => {
  it("two Sui offers on one network: the second offer's payment is verified against the second offer", async () => {
    const { fetchFn, bodies } = facilitator({ success: true, transaction: DIGEST, network: "sui:testnet" });
    const opts = [suiOpts({ amount: "5000", fetchFn }), suiOpts({ amount: AMOUNT, fetchFn })];
    const res402 = makeRes();
    await x402Middleware(opts as any)({ headers: {}, url: "/premium", method: "GET" }, res402, vi.fn());
    const second = JSON.parse(fromBase64(res402._headers()["PAYMENT-REQUIRED"])).accepts[1];
    expect(second.amount).toBe(AMOUNT);
    const req: Json = { headers: { "x-payment": paymentHeader(second) }, url: "/premium", method: "GET" };
    const res = makeRes();
    const next = vi.fn();
    await x402Middleware(opts as any)(req as any, res, next);
    expect(bodies[0].paymentRequirements.amount).toBe(AMOUNT);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Sui paid request", () => {
  it("express: facilitator binding holds, handler runs, payer from verify", async () => {
    const { res, next, req, bodies } = await payExpress({ success: true, transaction: DIGEST, network: "sui:testnet" });
    expect(bodies.map((b) => b.paymentRequirements.amount)).toEqual([AMOUNT, AMOUNT]);
    expect(next).toHaveBeenCalledOnce();
    expect(req.x402).toMatchObject({ payer: SUI_BUYER, txHash: DIGEST, network: "sui-testnet" });
    expect(JSON.parse(fromBase64(res._headers()["PAYMENT-RESPONSE"])).transaction).toBe(DIGEST);
  });

  it("nextjs: facilitator binding holds, handler runs, payer from verify", async () => {
    const { res, handler } = await payNext({ success: true, transaction: DIGEST, network: "sui:testnet" });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ payer: SUI_BUYER });
  });
});

describe("Sui settlement outcomes never answer 402 once money may have moved", () => {
  const pending = { success: false, payer: SUI_BUYER, transaction: DIGEST, errorReason: "settlement_pending" };
  const duplicate = { success: false, payer: SUI_BUYER, transaction: DIGEST, errorReason: "duplicate_settlement" };
  const thrown = () => { throw new Error("socket hang up"); };

  it("express: settlement_pending → 202 with digest, handler not run", async () => {
    const { res, next } = await payExpress(pending);
    expect(res._status()).toBe(202);
    expect(res._body()).toMatchObject({ pending: true, payment: { txHash: DIGEST } });
    expect(next).not.toHaveBeenCalled();
  });

  it("nextjs: settlement_pending → 202 with digest, handler not run", async () => {
    const { res, handler } = await payNext(pending);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pending: true, payment: { txHash: DIGEST } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("express: duplicate_settlement → 409 with digest, handler not run", async () => {
    const { res, next } = await payExpress(duplicate);
    expect(res._status()).toBe(409);
    expect(res._body()).toMatchObject({ reason: "duplicate_settlement", payment: { txHash: DIGEST } });
    expect(next).not.toHaveBeenCalled();
  });

  it("nextjs: duplicate_settlement → 409 with digest, handler not run", async () => {
    const { res, handler } = await payNext(duplicate);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "duplicate_settlement", payment: { txHash: DIGEST } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("express: settle throws → 504 outcome unknown, not 402", async () => {
    const { res, next } = await payExpress(thrown);
    expect(res._status()).toBe(504);
    expect(res._body()).toMatchObject({ outcome: "unknown" });
    expect(next).not.toHaveBeenCalled();
  });

  it("nextjs: settle throws → 504 outcome unknown, not 402", async () => {
    const { res, handler } = await payNext(thrown);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ outcome: "unknown" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("express: terminal settle failure (invalid_payload) stays 402", async () => {
    const { res, next } = await payExpress({ success: false, payer: "unknown", transaction: "", errorReason: "invalid_payload" });
    expect(res._status()).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });
});
