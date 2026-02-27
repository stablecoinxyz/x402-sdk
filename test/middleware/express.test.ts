import { describe, it, expect, vi } from "vitest";
import { x402Middleware } from "../../src/middleware/express.js";
import { makeFetchResponse, toBase64, fromBase64 } from "../helpers.js";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const AMOUNT = "1000000";
const NETWORK = "base-sepolia";


// ---- Minimal req/res/next mocks ----

function makeRes() {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const headers: Record<string, string> = {};

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    // Exposed for assertions
    _status: () => statusCode,
    _body: () => jsonBody,
    _headers: () => headers,
  };
  return res;
}

function makeReq(headers: Record<string, string> = {}, url = "/premium"): {
  headers: Record<string, string>;
  url: string;
  method: string;
} {
  return { headers, url, method: "GET" };
}

function makeNext() {
  return vi.fn();
}

function makeMockFetch(verify: object, settle: object) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    if (url.endsWith("/verify")) return makeFetchResponse(200, verify);
    if (url.endsWith("/settle")) return makeFetchResponse(200, settle);
    throw new Error(`Unexpected: ${url}`);
  });
}

function makePaymentHeader(payload: object = { accepted: { network: "eip155:84532", scheme: "exact" }, payload: {} }) {
  return toBase64(JSON.stringify(payload));
}

describe("x402Middleware — throws on unsupported network", () => {
  it("throws at setup time if network is unknown", () => {
    expect(() => x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: "fantom" }))
      .toThrow(/unsupported network/i);
  });
});

describe("x402Middleware — missing payment header → 402", () => {
  it("returns 402 when no payment header is present", async () => {
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK });
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();

    await middleware(req, res, next);

    expect(res._status()).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets PAYMENT-REQUIRED header with base64-encoded requirements", async () => {
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK });
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());

    const header = res._headers()["PAYMENT-REQUIRED"];
    expect(header).toBeDefined();
    const decoded = JSON.parse(fromBase64(header));
    expect(decoded.x402Version).toBe(2);
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts[0].payTo).toBe(PAY_TO);
    expect(decoded.accepts[0].maxAmountRequired).toBe(AMOUNT);
    expect(decoded.accepts[0].network).toBe(NETWORK);
  });

  it("402 JSON body includes x402Version and accepts array", async () => {
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK });
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());

    const body = res._body() as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
  });

  it("uses custom asset if provided", async () => {
    const customAsset = "0xcustom";
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK, asset: customAsset });
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());

    const header = res._headers()["PAYMENT-REQUIRED"];
    const decoded = JSON.parse(fromBase64(header));
    expect(decoded.accepts[0].asset).toBe(customAsset);
  });

  it("scheme in requirement is 'exact'", async () => {
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK });
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());

    const decoded = JSON.parse(fromBase64(res._headers()["PAYMENT-REQUIRED"]));
    expect(decoded.accepts[0].scheme).toBe("exact");
  });
});

describe("x402Middleware — invalid payment header", () => {
  it("returns 402 with error when header is not valid base64 JSON", async () => {
    const middleware = x402Middleware({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK });
    const res = makeRes();
    await middleware(
      makeReq({ "payment-signature": "not-valid-base64!!!" }),
      res,
      makeNext()
    );

    expect(res._status()).toBe(402);
    const body = res._body() as Record<string, unknown>;
    expect(body.error).toMatch(/invalid/i);
  });
});

describe("x402Middleware — valid payment → verify + settle + next()", () => {
  it("calls verify then settle then next() on success", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0xabc" });
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      fetchFn,
    });
    const next = makeNext();
    const res = makeRes();

    await middleware(
      makeReq({ "payment-signature": makePaymentHeader() }),
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error arg
    expect(res._status()).toBe(200); // status unchanged (200 default)
  });

  it("sets PAYMENT-RESPONSE header with txHash after settlement", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0xdeadbeef" });
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      fetchFn,
    });
    const res = makeRes();

    await middleware(
      makeReq({ "payment-signature": makePaymentHeader() }),
      res,
      makeNext()
    );

    const paymentResponseHeader = res._headers()["PAYMENT-RESPONSE"];
    expect(paymentResponseHeader).toBeDefined();
    const decoded = JSON.parse(fromBase64(paymentResponseHeader));
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe("0xdeadbeef");
    expect(decoded.network).toBe(NETWORK);
  });

  it("also accepts X-PAYMENT header (V1 backward compat)", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0x1" });
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      fetchFn,
    });
    const next = makeNext();

    await middleware(
      makeReq({ "x-payment": makePaymentHeader() }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalled();
  });
});

describe("x402Middleware — verify failure", () => {
  it("returns 402 when verify returns isValid:false", async () => {
    const fetchFn = makeMockFetch({ isValid: false, invalidReason: "Expired" }, {});
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      fetchFn,
    });
    const next = makeNext();
    const res = makeRes();

    await middleware(
      makeReq({ "payment-signature": makePaymentHeader() }),
      res,
      next
    );

    expect(res._status()).toBe(402);
    expect(next).not.toHaveBeenCalled();
    const body = res._body() as Record<string, unknown>;
    expect(body.error).toContain("Expired");
  });
});

describe("x402Middleware — settle failure", () => {
  it("returns 402 with error when settle fails", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: false, error: "Gas too low" });
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      fetchFn,
    });
    const next = makeNext();
    const res = makeRes();

    await middleware(
      makeReq({ "payment-signature": makePaymentHeader() }),
      res,
      next
    );

    expect(res._status()).toBe(402);
    expect(next).not.toHaveBeenCalled();
    const body = res._body() as Record<string, unknown>;
    expect(body.error).toContain("Gas too low");
  });
});

describe("x402Middleware — multi-network (array input)", () => {
  const EVM_PAY_TO = "0xaaaa000000000000000000000000000000000000";
  const SOL_PAY_TO = "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K";

  it("returns 402 with multiple accepts entries when no payment header", async () => {
    const middleware = x402Middleware([
      { payTo: EVM_PAY_TO, amount: "1000000", network: "base-sepolia" },
      { payTo: SOL_PAY_TO, amount: "1000000", network: "solana-devnet" },
    ]);
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());

    expect(res._status()).toBe(402);
    const decoded = JSON.parse(fromBase64(res._headers()["PAYMENT-REQUIRED"]));
    expect(decoded.accepts).toHaveLength(2);
    expect(decoded.accepts[0].network).toBe("base-sepolia");
    expect(decoded.accepts[1].network).toBe("solana-devnet");
  });

  it("routes EVM payment to EVM facilitator", async () => {
    const evmFetch = makeMockFetch({ isValid: true }, { success: true, txHash: "0xevm" });
    const middleware = x402Middleware([
      { payTo: EVM_PAY_TO, amount: "1000000", network: "base-sepolia", facilitatorUrl: "https://evm.test", fetchFn: evmFetch },
      { payTo: SOL_PAY_TO, amount: "1000000", network: "solana-devnet", facilitatorUrl: "https://sol.test", fetchFn: vi.fn() },
    ]);
    const next = makeNext();
    const evmPayload = { accepted: { network: "eip155:84532", scheme: "exact" }, payload: {} };
    await middleware(makeReq({ "payment-signature": toBase64(JSON.stringify(evmPayload)) }), makeRes(), next);

    expect(next).toHaveBeenCalled();
    const calls = evmFetch.mock.calls.map((a) => typeof a[0] === "string" ? a[0] : String(a[0]));
    expect(calls.some((u) => u.includes("evm.test"))).toBe(true);
  });

  it("returns 402 with error when payment network doesn't match any option", async () => {
    const middleware = x402Middleware([
      { payTo: EVM_PAY_TO, amount: "1000000", network: "base-sepolia" },
    ]);
    const res = makeRes();
    const next = makeNext();
    const solPayload = { accepted: { network: "solana:devnet", scheme: "exact" }, payload: {} };
    await middleware(makeReq({ "payment-signature": toBase64(JSON.stringify(solPayload)) }), res, next);

    expect(res._status()).toBe(402);
    expect(next).not.toHaveBeenCalled();
    const body = res._body() as Record<string, unknown>;
    expect(body.error).toMatch(/no payment option/i);
  });
});

describe("x402Middleware — settle: false (verify-only mode)", () => {
  it("skips settle and calls next() after successful verify", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.endsWith("/verify")) return makeFetchResponse(200, { isValid: true });
      throw new Error(`Unexpected: ${url}`);
    });
    const middleware = x402Middleware({
      payTo: PAY_TO,
      amount: AMOUNT,
      network: NETWORK,
      facilitatorUrl: "https://f.test",
      settle: false,
      fetchFn,
    });
    const next = makeNext();

    await middleware(
      makeReq({ "payment-signature": makePaymentHeader() }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalled();
    const allUrls = fetchFn.mock.calls.map((args) =>
      typeof args[0] === "string" ? args[0] : (args[0] as URL).href
    );
    expect(allUrls.some((u) => u.endsWith("/settle"))).toBe(false);
  });
});
