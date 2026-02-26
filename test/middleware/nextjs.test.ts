import { describe, it, expect, vi } from "vitest";
import { withX402 } from "../../src/middleware/nextjs.js";
import { makeFetchResponse, toBase64, fromBase64 } from "../helpers.js";

const PAY_TO = "0xabcdef1234567890abcdef1234567890abcdef12";
const AMOUNT = "1000000";
const NETWORK = "base-sepolia";

function makeRequest(headers: Record<string, string> = {}, url = "https://api.example.com/premium"): Request {
  return new Request(url, { headers });
}

function makePaymentHeader(payload: object = { accepted: { network: "eip155:84532", scheme: "exact" }, payload: {} }) {
  return toBase64(JSON.stringify(payload));
}

function makeMockFetch(verify: object, settle: object) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    if (url.endsWith("/verify")) return makeFetchResponse(200, verify);
    if (url.endsWith("/settle")) return makeFetchResponse(200, settle);
    throw new Error(`Unexpected: ${url}`);
  });
}

describe("withX402 — throws on unsupported network at setup", () => {
  it("throws when network is unknown", () => {
    expect(() =>
      withX402({ payTo: PAY_TO, amount: AMOUNT, network: "avalanche" }, async () => new Response("ok"))
    ).toThrow(/unsupported network/i);
  });
});

describe("withX402 — missing payment header → 402", () => {
  it("returns 402 when no payment header", async () => {
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK },
      async () => new Response(JSON.stringify({ secret: true }), { status: 200 })
    );
    const res = await handler(makeRequest());
    expect(res.status).toBe(402);
  });

  it("402 body is valid JSON with x402Version and accepts", async () => {
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK },
      async () => new Response()
    );
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0].payTo).toBe(PAY_TO);
    expect(body.accepts[0].maxAmountRequired).toBe(AMOUNT);
  });

  it("sets PAYMENT-REQUIRED header with base64-encoded requirements", async () => {
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK },
      async () => new Response()
    );
    const res = await handler(makeRequest());
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).not.toBeNull();
    const decoded = JSON.parse(fromBase64(header!));
    expect(decoded.accepts[0].network).toBe(NETWORK);
    expect(decoded.accepts[0].payTo).toBe(PAY_TO);
  });

  it("handler is not called when payment is missing", async () => {
    const handlerFn = vi.fn(async () => new Response("secret"));
    const handler = withX402({ payTo: PAY_TO, amount: AMOUNT, network: NETWORK }, handlerFn);

    await handler(makeRequest());
    expect(handlerFn).not.toHaveBeenCalled();
  });
});

describe("withX402 — invalid header", () => {
  it("returns 402 with error when header is malformed", async () => {
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK },
      async () => new Response()
    );
    const res = await handler(makeRequest({ "payment-signature": "!!not-base64!!" }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("withX402 — valid payment → calls handler", () => {
  it("calls handler and returns its response on successful payment", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0xcafe" });
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async () => new Response(JSON.stringify({ secret: "data" }), { status: 200 })
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBe("data");
  });

  it("merges PAYMENT-RESPONSE header into handler response", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0xdeadbeef" });
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
    expect(paymentResponse).not.toBeNull();
    const decoded = JSON.parse(fromBase64(paymentResponse!));
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe("0xdeadbeef");
    expect(decoded.network).toBe(NETWORK);
  });

  it("preserves handler's existing headers alongside PAYMENT-RESPONSE", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0x1" });
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async () =>
        new Response("ok", { status: 200, headers: { "X-Custom": "preserved" } })
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    expect(res.headers.get("X-Custom")).toBe("preserved");
    expect(res.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
  });

  it("also accepts x-payment header (V1 compat)", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0x1" });
    const handlerFn = vi.fn(async () => new Response("ok"));
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      handlerFn
    );

    const res = await handler(makeRequest({ "x-payment": makePaymentHeader() }));

    expect(res.status).toBe(200);
    expect(handlerFn).toHaveBeenCalled();
  });

  it("passes original request and context to the handler", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: true, txHash: "0x1" });
    let receivedRequest: Request | undefined;
    let receivedContext: unknown;

    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async (req, ctx) => {
        receivedRequest = req;
        receivedContext = ctx;
        return new Response("ok");
      }
    );

    const originalReq = makeRequest({ "payment-signature": makePaymentHeader() });
    await handler(originalReq, { params: { id: "123" } });

    expect(receivedRequest).toBe(originalReq);
    expect(receivedContext).toEqual({ params: { id: "123" } });
  });
});

describe("withX402 — verify failure", () => {
  it("returns 402 when verify returns isValid:false", async () => {
    const fetchFn = makeMockFetch({ isValid: false, invalidReason: "Replay detected" }, {});
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async () => new Response("secret")
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("Replay detected");
  });
});

describe("withX402 — settle failure", () => {
  it("returns 402 when settle fails", async () => {
    const fetchFn = makeMockFetch({ isValid: true }, { success: false, error: "Chain congestion" });
    const handler = withX402(
      { payTo: PAY_TO, amount: AMOUNT, network: NETWORK, facilitatorUrl: "https://f.test", fetchFn },
      async () => new Response("secret")
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("Chain congestion");
  });
});

describe("withX402 — settle: false (verify-only mode)", () => {
  it("skips settle and calls handler after verify-only", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.endsWith("/verify")) return makeFetchResponse(200, { isValid: true });
      throw new Error(`Unexpected: ${url}`);
    });
    const handlerFn = vi.fn(async () => new Response("ok"));
    const handler = withX402(
      {
        payTo: PAY_TO,
        amount: AMOUNT,
        network: NETWORK,
        facilitatorUrl: "https://f.test",
        settle: false,
        fetchFn,
      },
      handlerFn
    );

    const res = await handler(makeRequest({ "payment-signature": makePaymentHeader() }));

    expect(res.status).toBe(200);
    expect(handlerFn).toHaveBeenCalled();
    const allUrls = fetchFn.mock.calls.map((args) =>
      typeof args[0] === "string" ? args[0] : (args[0] as URL).href
    );
    expect(allUrls.some((u) => u.endsWith("/settle"))).toBe(false);
  });
});
