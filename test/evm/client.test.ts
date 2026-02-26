import { describe, it, expect, vi } from "vitest";
import { createX402Client } from "../../src/evm/client.js";
import { InsufficientBalanceError } from "../../src/core/errors.js";
import {
  createMockSigner,
  make402Body,
  makeFetchResponse,
  abiEncodeUint256,
  toBase64,
  fromBase64,
} from "../helpers.js";

const TARGET_URL = "https://api.example.com/premium";
const FACILITATOR_URL = "https://f.test";
const RPC_URL = "https://rpc.test";

// ---- Mock fetch dispatcher for the full payment flow ----
// Client no longer calls verify/settle — server handles that.
// The second API call returns the paid response (with optional PAYMENT-RESPONSE header).
function makeFlowFetch(opts: {
  network?: string;
  apiStatus?: number;
  apiBody?: unknown;
  nonce?: bigint;
  balance?: bigint;
  paymentResponse?: string; // base64-encoded PAYMENT-RESPONSE header value
}) {
  const {
    network = "base-sepolia",
    apiStatus = 200,
    apiBody = { data: "premium" },
    nonce = 3n,
    balance = 10_000_000n,
    paymentResponse,
  } = opts;

  let apiCallCount = 0;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input as Request).url);

    if (url.startsWith(TARGET_URL)) {
      apiCallCount++;
      if (apiCallCount === 1) return makeFetchResponse(402, make402Body({ network }));
      const headers: Record<string, string> = {};
      if (paymentResponse) headers["PAYMENT-RESPONSE"] = paymentResponse;
      return makeFetchResponse(apiStatus, apiBody, Object.keys(headers).length ? headers : undefined);
    }

    if (url === RPC_URL) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "eth_call") {
        const callData: string = body.params[0]?.data ?? "";
        if (callData.startsWith("0x7ecebe00"))
          return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(nonce) });
        if (callData.startsWith("0x70a08231"))
          return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(balance) });
      }
    }

    // /supported — return undefined signer (use requirement.facilitator fallback)
    if (url.endsWith("/supported")) return makeFetchResponse(200, { signers: {} });

    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

// ---- Non-402 passthrough ----

describe("createX402Client — non-402 responses", () => {
  it("returns 200 response unchanged without any payment logic", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFetchResponse(200, { hello: "world" }));
    const signer = createMockSigner();
    const client = createX402Client({ signer, fetchFn });

    const res = await client.fetch(TARGET_URL);

    expect(res.status).toBe(200);
    expect(signer.calls).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns non-402 error response unchanged without signing", async () => {
    const signer = createMockSigner();
    const client = createX402Client({
      signer,
      fetchFn: vi.fn().mockResolvedValue(makeFetchResponse(500, "Internal Error")),
    });
    const res = await client.fetch(TARGET_URL);
    expect(res.status).toBe(500);
    expect(signer.calls).toHaveLength(0);
  });
});

// ---- Full payment flow ----

describe("createX402Client — full x402 payment flow", () => {
  it("completes payment flow and returns paid response with paymentResult", async () => {
    const paymentResponse = toBase64(
      JSON.stringify({ success: true, transaction: "0xdeadbeef", network: "base-sepolia" })
    );
    const fetchFn = makeFlowFetch({ paymentResponse });
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });

    const res = await client.fetch(TARGET_URL);

    expect(res.status).toBe(200);
    expect(res.paymentResult?.success).toBe(true);
    expect(res.paymentResult?.txHash).toBe("0xdeadbeef");
    expect(res.paymentResult?.network).toBe("base-sepolia");
    expect(res.paymentResult?.amountPaid).toBe("1000000");
  });

  it("makes exactly 2 API calls (no verify/settle from client)", async () => {
    const fetchFn = makeFlowFetch({});
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const urls = fetchFn.mock.calls.map(([u]: [RequestInfo | URL]) =>
      typeof u === "string" ? u : (u instanceof URL ? u.href : (u as Request).url)
    );
    expect(urls.filter((u) => u.startsWith(TARGET_URL))).toHaveLength(2);
    expect(urls.filter((u) => u.endsWith("/verify"))).toHaveLength(0);
    expect(urls.filter((u) => u.endsWith("/settle"))).toHaveLength(0);
  });

  it("second API call includes PAYMENT-SIGNATURE header with base64 PaymentPayload", async () => {
    const fetchFn = makeFlowFetch({});
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const apiCalls = fetchFn.mock.calls.filter(([u]: [RequestInfo | URL]) =>
      typeof u === "string" && u.startsWith(TARGET_URL)
    );
    const secondCallHeaders = apiCalls[1][1]?.headers as Record<string, string>;
    expect(secondCallHeaders["PAYMENT-SIGNATURE"]).toBeDefined();

    const decoded = JSON.parse(fromBase64(secondCallHeaders["PAYMENT-SIGNATURE"]));
    // New v2 format: accepted.network (CAIP-2), accepted.scheme, payload
    expect(decoded.accepted.network).toBe("eip155:84532"); // base-sepolia CAIP-2
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.payload).toBeDefined();
  });

  it("also sends X-PAYMENT for V1 backward compatibility, matching PAYMENT-SIGNATURE", async () => {
    const fetchFn = makeFlowFetch({});
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const apiCalls = fetchFn.mock.calls.filter(([u]: [RequestInfo | URL]) =>
      typeof u === "string" && u.startsWith(TARGET_URL)
    );
    const headers = apiCalls[1][1]?.headers as Record<string, string>;
    expect(headers["X-PAYMENT"]).toBe(headers["PAYMENT-SIGNATURE"]);
  });

  it("signer is called once, with EIP-712 Permit typed data for SBC network", async () => {
    const signer = createMockSigner();
    const client = createX402Client({
      signer,
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn: makeFlowFetch({}),
    });
    await client.fetch(TARGET_URL);

    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0].primaryType).toBe("Permit");
    // verifyingContract is the token (not facilitator)
    const domain = signer.calls[0].domain as Record<string, unknown>;
    expect(domain.verifyingContract).toBe("0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16");
  });

  it("parses PAYMENT-RESPONSE header from final response for txHash", async () => {
    const paymentResponse = toBase64(
      JSON.stringify({ success: true, transaction: "0xconfirmed", network: "base-sepolia" })
    );

    const fetchFn = makeFlowFetch({ paymentResponse });
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });

    const res = await client.fetch(TARGET_URL);
    expect(res.paymentResult?.txHash).toBe("0xconfirmed");
  });

  it("paymentResult.txHash is undefined when server sends no PAYMENT-RESPONSE header", async () => {
    const fetchFn = makeFlowFetch({}); // no paymentResponse
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });

    const res = await client.fetch(TARGET_URL);
    expect(res.paymentResult?.txHash).toBeUndefined();
  });
});

// ---- Error handling ----

describe("createX402Client — payment flow error handling", () => {
  it("throws when server returns 402 again after payment", async () => {
    let callCount = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.startsWith(TARGET_URL)) {
        callCount++;
        return makeFetchResponse(402, make402Body({})); // always 402
      }
      if (url === RPC_URL)
        return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(0n) });
      if (url.endsWith("/supported")) return makeFetchResponse(200, { signers: {} });
      throw new Error(`Unexpected: ${url}`);
    });

    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });

    await expect(client.fetch(TARGET_URL)).rejects.toThrow(/402.*payment/i);
  });

  it("throws InsufficientBalanceError when token balance is below required amount", async () => {
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: false,
      fetchFn: makeFlowFetch({ balance: 0n }), // zero balance
    });

    await expect(client.fetch(TARGET_URL)).rejects.toThrow(InsufficientBalanceError);
  });

  it("succeeds despite zero balance when skipBalanceCheck is true", async () => {
    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn: makeFlowFetch({ balance: 0n }),
    });

    const res = await client.fetch(TARGET_URL);
    expect(res.status).toBe(200);
  });

  it("throws on malformed 402 body (not valid JSON)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("not json", { status: 402, headers: { "Content-Type": "text/plain" } })
    );
    const client = createX402Client({ signer: createMockSigner(), fetchFn });

    await expect(client.fetch(TARGET_URL)).rejects.toThrow(/not valid JSON/i);
  });

  it("throws when no accepts array in 402 response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(402, { x402Version: 2, accepts: [] })
    );
    const client = createX402Client({ signer: createMockSigner(), fetchFn });

    await expect(client.fetch(TARGET_URL)).rejects.toThrow(/accepts/i);
  });
});

// ---- PAYMENT-REQUIRED header parsing ----

describe("createX402Client — PAYMENT-REQUIRED header parsing", () => {
  it("prefers base64-encoded PAYMENT-REQUIRED header over body", async () => {
    const headerRequirements = {
      x402Version: 2,
      accepts: [{
        scheme: "exact" as const,
        network: "base-sepolia",
        maxAmountRequired: "2500000", // different from body
        resource: TARGET_URL,
        payTo: "0xpayto000000000000000000000000000000000000",
        asset: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16",
        maxTimeoutSeconds: 300,
        facilitator: "0x124b082e8df36258198da4caa3b39c7dfa64d9ce",
        extra: { name: "SBC" },
      }],
    };
    const headerValue = toBase64(JSON.stringify(headerRequirements));

    let apiCallCount = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.startsWith(TARGET_URL)) {
        apiCallCount++;
        if (apiCallCount === 1) {
          return new Response(JSON.stringify({ x402Version: 2, accepts: [{ maxAmountRequired: "1000000" }] }), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": headerValue, "Content-Type": "application/json" },
          });
        }
        return makeFetchResponse(200, { ok: true });
      }
      if (url === RPC_URL)
        return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(0n) });
      if (url.endsWith("/supported")) return makeFetchResponse(200, { signers: {} });
      throw new Error(`Unexpected: ${url}`);
    });

    const client = createX402Client({
      signer: createMockSigner(),
      facilitatorUrl: FACILITATOR_URL,
      rpcUrl: RPC_URL,
      skipBalanceCheck: true,
      fetchFn,
    });

    const res = await client.fetch(TARGET_URL);
    // Amount from the PAYMENT-REQUIRED header, not the body
    expect(res.paymentResult?.amountPaid).toBe("2500000");
  });
});
