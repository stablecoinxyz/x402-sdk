/**
 * The 402 offer must be one a Permit2 buyer can echo back and the SBC facilitator will accept.
 *
 * `facilitatorAccepts` mirrors the envelope check in x402-facilitator
 * src/routes/verify.ts:341 and src/routes/settle.ts:591: the buyer's `accepted` must equal
 * `paymentRequirements` on network, amount, asset, payTo, extra.name and extra.version, and
 * carry extra.assetTransferMethod "permit2".
 */
import { describe, it, expect, vi } from "vitest";
import { x402Middleware } from "../../src/middleware/express.js";
import { withX402 } from "../../src/middleware/nextjs.js";
import { makeFetchResponse, toBase64, fromBase64 } from "../helpers.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const BUYER = "0x9999999999999999999999999999999999999999";
const RADIUS_TESTNET_SBC = "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb";

type Json = Record<string, any>;

function facilitatorAccepts(accepted: Json, requirements: Json): boolean {
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  return (
    accepted.network === requirements.network &&
    accepted.amount === requirements.amount &&
    same(accepted.asset, requirements.asset) &&
    same(accepted.payTo, requirements.payTo) &&
    accepted.extra?.assetTransferMethod === "permit2" &&
    accepted.extra?.name === requirements.extra?.name &&
    accepted.extra?.version === requirements.extra?.version
  );
}

/** What a Permit2 buyer (e.g. agent-payments lib/permit-signer.ts) echoes from an offer. */
function echo(offer: Json): Json {
  const { scheme, network, amount, asset, payTo, extra } = offer;
  return { scheme, network, amount, asset, payTo, extra };
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
    _body: () => jsonBody,
    _headers: () => headers,
  };
  return res;
}

async function offerFromExpress(opts: Parameters<typeof x402Middleware>[0]): Promise<Json[]> {
  const res = makeRes();
  await x402Middleware(opts)({ headers: {}, url: "/premium", method: "GET" }, res, vi.fn());
  expect(res._status()).toBe(402);
  return JSON.parse(fromBase64(res._headers()["PAYMENT-REQUIRED"])).accepts;
}

function recordingFetch(verify: Json = { isValid: true, payer: BUYER }) {
  const bodies: Record<string, Json> = {};
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    const path = url.endsWith("/verify") ? "verify" : url.endsWith("/settle") ? "settle" : "";
    if (!path) throw new Error(`Unexpected: ${url}`);
    bodies[path] = JSON.parse(String(init?.body));
    return makeFetchResponse(200, path === "verify" ? verify : { success: true, transaction: "0x" + "ab".repeat(32) });
  });
  return { fn, bodies };
}

describe("EVM 402 offer — Permit2 shape", () => {
  it("advertises CAIP-2 network, amount and the permit2 extra, with no ERC-2612 spender", async () => {
    const [offer] = await offerFromExpress({ payTo: PAY_TO, amount: "1000", network: "radius-testnet" });
    expect(offer).toEqual({
      scheme: "exact",
      network: "eip155:72344",
      amount: "1000",
      maxAmountRequired: "1000",
      resource: "/premium",
      payTo: PAY_TO,
      asset: RADIUS_TESTNET_SBC,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "permit2", name: "Stable Coin", version: "1" },
    });
  });

  it("Next.js wrapper advertises the same offer", async () => {
    const handler = withX402({ payTo: PAY_TO, amount: "1000", network: "base" }, async () => new Response("ok"));
    const res = await handler(new Request("https://api.example.com/premium"));
    const [offer] = JSON.parse(fromBase64(res.headers.get("PAYMENT-REQUIRED")!)).accepts;
    expect(offer.network).toBe("eip155:8453");
    expect(offer.amount).toBe("1000");
    expect(offer.extra).toEqual({ assetTransferMethod: "permit2", name: "Stable Coin", version: "1" });
    expect(offer).not.toHaveProperty("facilitator");
  });

  it("uses the token's own EIP-712 domain for a known non-default asset", async () => {
    const [offer] = await offerFromExpress({
      payTo: PAY_TO, amount: "1000", network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(offer.extra).toEqual({ assetTransferMethod: "permit2", name: "USD Coin", version: "2" });
  });

  it("leaves Solana offers in their previous shape", async () => {
    const [offer] = await offerFromExpress({
      payTo: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K", amount: "1000", network: "solana-devnet", asset: "Mint1111",
    });
    expect(offer).toEqual({
      scheme: "exact",
      network: "solana-devnet",
      maxAmountRequired: "1000",
      resource: "/premium",
      payTo: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K",
      asset: "Mint1111",
      maxTimeoutSeconds: 300,
      facilitator: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K",
    });
  });
});

describe("EVM payment round trip — facilitator envelope check", () => {
  it("forwards requirements that equal the buyer's echo of the offer", async () => {
    const opts = { payTo: PAY_TO, amount: "1000", network: "radius-testnet" };
    const [offer] = await offerFromExpress(opts);
    const { fn, bodies } = recordingFetch();
    const header = toBase64(JSON.stringify({
      x402Version: 2,
      accepted: echo(offer),
      payload: { signature: "0x00", permit2Authorization: { from: BUYER } },
    }));
    const res = makeRes();
    const next = vi.fn();
    await x402Middleware({ ...opts, fetchFn: fn })({ headers: { "x-payment": header }, url: "/premium", method: "GET" }, res, next);

    expect(next).toHaveBeenCalled();
    for (const path of ["verify", "settle"]) {
      const { paymentPayload, paymentRequirements } = bodies[path];
      expect(facilitatorAccepts(paymentPayload.accepted, paymentRequirements)).toBe(true);
    }
  });
});

describe("payer reported to the handler", () => {
  it("is the facilitator's recovered payer, not a payload field", async () => {
    const opts = { payTo: PAY_TO, amount: "1000", network: "radius-testnet" };
    const [offer] = await offerFromExpress(opts);
    const { fn } = recordingFetch({ isValid: true, payer: BUYER });
    const header = toBase64(JSON.stringify({
      accepted: echo(offer),
      payload: { signature: "0x00", permit2Authorization: { from: "0x1111111111111111111111111111111111111111" } },
    }));
    const req: Json = { headers: { "x-payment": header }, url: "/premium", method: "GET" };
    await x402Middleware({ ...opts, fetchFn: fn })(req as any, makeRes(), vi.fn());
    expect(req.x402.payer).toBe(BUYER);
  });

  it("falls back to permit2Authorization.from when the facilitator names no payer", async () => {
    const opts = { payTo: PAY_TO, amount: "1000", network: "radius-testnet" };
    const [offer] = await offerFromExpress(opts);
    const { fn } = recordingFetch({ isValid: true });
    const header = toBase64(JSON.stringify({
      accepted: echo(offer),
      payload: { signature: "0x00", permit2Authorization: { from: BUYER } },
    }));
    const req: Json = { headers: { "x-payment": header }, url: "/premium", method: "GET" };
    await x402Middleware({ ...opts, fetchFn: fn })(req as any, makeRes(), vi.fn());
    expect(req.x402.payer).toBe(BUYER);
  });
});

describe("misconfiguration fails at construction", () => {
  const base = { payTo: PAY_TO, amount: "1000", network: "base-sepolia" };

  it("rejects an unknown EVM asset without its EIP-712 domain", () => {
    expect(() => x402Middleware({ ...base, asset: "0x" + "12".repeat(20) })).toThrow(/tokenName and tokenVersion/);
  });

  it("accepts an unknown EVM asset with its EIP-712 domain", async () => {
    const asset = "0x" + "12".repeat(20);
    const [offer] = await offerFromExpress({ ...base, asset, tokenName: "My Token", tokenVersion: "3" });
    expect(offer.extra).toEqual({ assetTransferMethod: "permit2", name: "My Token", version: "3" });
  });

  it("rejects a domain that contradicts a known token", () => {
    expect(() => x402Middleware({ ...base, tokenName: "USD Coin", tokenVersion: "2" })).toThrow(/EIP-712 domain/);
  });

  it("rejects a non-address payTo on EVM", () => {
    expect(() => x402Middleware({ ...base, payTo: "0xabc" })).toThrow(/payTo/);
  });

  it("rejects a non-integer amount on EVM", () => {
    expect(() => x402Middleware({ ...base, amount: "0.5" })).toThrow(/amount/);
  });
});
