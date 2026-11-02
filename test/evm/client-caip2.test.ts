import { describe, it, expect, vi } from "vitest";
import { createX402Client } from "../../src/evm/client.js";
import { createMockSigner, makeFetchResponse, abiEncodeUint256, fromBase64 } from "../helpers.js";

const TARGET_URL = "https://api.example.com/premium";

describe("createX402Client — offers from paywall >= 0.5 (CAIP-2 networks)", () => {
  it("picks the EVM offer, not a Solana one, from a mixed 402", async () => {
    const accepts = [
      { scheme: "exact", network: "solana-devnet", maxAmountRequired: "1", resource: TARGET_URL, payTo: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K", asset: "Mint", maxTimeoutSeconds: 300 },
      {
        scheme: "exact", network: "eip155:84532", amount: "1000000", maxAmountRequired: "1000000", resource: TARGET_URL,
        payTo: "0x1234567890123456789012345678901234567890", asset: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16",
        maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2", name: "Stable Coin", version: "1" },
      },
    ];
    let paidHeader: string | null = null;
    let calls = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url.startsWith(TARGET_URL)) {
        calls++;
        if (calls === 1) return makeFetchResponse(402, JSON.stringify({ x402Version: 2, accepts }));
        paidHeader = new Headers(init?.headers).get("payment-signature") ?? new Headers(init?.headers).get("x-payment");
        return makeFetchResponse(200, { ok: true });
      }
      if (url.endsWith("/supported")) return makeFetchResponse(200, { signers: {} });
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "eth_call") return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(10_000_000n) });
      throw new Error(`Unexpected fetch to: ${url}`);
    });
    const client = createX402Client({ signer: createMockSigner(), fetchFn, network: "base-sepolia" });
    await client.fetch(TARGET_URL);
    expect(paidHeader).not.toBeNull();
    expect(JSON.parse(fromBase64(paidHeader!)).accepted.network).toBe("eip155:84532");
  });
});
