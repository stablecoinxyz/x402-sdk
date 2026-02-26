/**
 * Shared test helpers
 */

import type { EvmSigner, Hex } from "../src/evm/signer.js";
import type { PaymentRequirement, PaymentPayload, AuthorizationPayload } from "../src/core/types.js";

// ---- Deterministic mock signature ----
// 65-byte ECDSA sig: r = 0xaa..., s = 0xbb..., v = 27 (0x1b)
export const MOCK_SIG = `0x${"a".repeat(64)}${"b".repeat(64)}1b` as Hex;

// ---- Mock EVM signer ----
export interface MockSignerCall {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export function createMockSigner(address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"): EvmSigner & {
  calls: MockSignerCall[];
} {
  const calls: MockSignerCall[] = [];
  return {
    address,
    calls,
    async signTypedData(params) {
      calls.push(params as unknown as MockSignerCall);
      return MOCK_SIG;
    },
  };
}

// ---- ABI helpers ----

/** ABI-encode a uint256 as a 32-byte hex string (for eth_call responses). */
export function abiEncodeUint256(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

// ---- Mock fetch factory ----

type MockResponse = { status: number; body: unknown; headers?: Record<string, string> };

export function makeFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Build a minimal x402 PaymentRequirementsResponse JSON string */
export function make402Body(overrides: Partial<PaymentRequirement> = {}): string {
  const req: PaymentRequirement = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000000",
    resource: "https://api.example.com/premium",
    payTo: "0x1234567890123456789012345678901234567890",
    asset: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16",
    maxTimeoutSeconds: 300,
    facilitator: "0x124b082e8df36258198da4caa3b39c7dfa64d9ce",
    extra: { name: "SBC" },
    ...overrides,
  };
  return JSON.stringify({ x402Version: 2, accepts: [req] });
}

/** Base64 encode a string (Node.js). */
export function toBase64(str: string): string {
  return Buffer.from(str).toString("base64");
}

/** Base64 decode a string (Node.js). */
export function fromBase64(str: string): string {
  return Buffer.from(str, "base64").toString("utf-8");
}

/** Make a mock PaymentPayload with an AuthorizationPayload (ERC-2612 Permit format) */
export function mockPermitPaymentPayload(): PaymentPayload {
  const authPayload: AuthorizationPayload = {
    authorization: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x124b082e8df36258198da4caa3b39c7dfa64d9ce",
      value: "1000000",
      validBefore: Math.floor(Date.now() / 1000) + 300,
      nonce: "0",
    },
    signature: MOCK_SIG,
  };
  return {
    accepted: { network: "eip155:84532", scheme: "exact" },
    payload: authPayload,
  };
}

/** Create a mock fetch that dispatches by URL pattern. */
export function createDispatchFetch(
  handlers: Array<{ match: (url: string, init?: RequestInit) => boolean; response: MockResponse }>
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    for (const handler of handlers) {
      if (handler.match(url, init)) {
        return makeFetchResponse(handler.response.status, handler.response.body, handler.response.headers ?? {});
      }
    }
    throw new Error(`No mock handler for fetch to: ${url}`);
  };
}
