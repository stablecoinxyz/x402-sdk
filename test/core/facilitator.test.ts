import { describe, it, expect, vi } from "vitest";
import { FacilitatorClient } from "../../src/core/facilitator.js";
import { FacilitatorError, PaymentTimeoutError } from "../../src/core/errors.js";
import { makeFetchResponse, mockPermitPaymentPayload } from "../helpers.js";
import type { PaymentRequirement } from "../../src/core/types.js";

const REQUIREMENT: PaymentRequirement = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000000",
  resource: "https://api.example.com/premium",
  payTo: "0x1234567890123456789012345678901234567890",
  asset: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16",
  maxTimeoutSeconds: 300,
  facilitator: "0x124b082e8df36258198da4caa3b39c7dfa64d9ce",
  extra: { name: "SBC" },
};

describe("FacilitatorClient.getFacilitatorUrl", () => {
  it("uses override URL when provided", () => {
    const client = new FacilitatorClient({ facilitatorUrl: "https://custom.facilitator.io" });
    expect(client.getFacilitatorUrl("base-sepolia")).toBe("https://custom.facilitator.io");
    expect(client.getFacilitatorUrl("base")).toBe("https://custom.facilitator.io");
  });

  it("uses network-specific default when no override", () => {
    const client = new FacilitatorClient();
    expect(client.getFacilitatorUrl("base")).toBe("https://sbc-x402-facilitator.fly.dev");
    expect(client.getFacilitatorUrl("base-sepolia")).toBe("https://sbc-x402-facilitator.fly.dev");
  });

  it("normalizes localhost to 127.0.0.1", () => {
    const client = new FacilitatorClient({ facilitatorUrl: "http://localhost:3000" });
    expect(client.getFacilitatorUrl("base")).toBe("http://127.0.0.1:3000");
  });

  it("normalizes localhost with path separator", () => {
    const client = new FacilitatorClient({ facilitatorUrl: "http://localhost/api" });
    expect(client.getFacilitatorUrl("base")).toBe("http://127.0.0.1/api");
  });
});

describe("FacilitatorClient.verify", () => {
  it("returns isValid:true on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { isValid: true })
    );
    const client = new FacilitatorClient({
      facilitatorUrl: "https://facilitator.test",
      fetchFn,
    });

    const result = await client.verify(mockPermitPaymentPayload(), REQUIREMENT);

    expect(result.isValid).toBe(true);
  });

  it("returns isValid:false with reason", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { isValid: false, invalidReason: "Expired deadline" })
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    const result = await client.verify(mockPermitPaymentPayload(), REQUIREMENT);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("Expired deadline");
  });

  it("sends correct request structure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { isValid: true })
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    const payload = mockPermitPaymentPayload();
    await client.verify(payload, REQUIREMENT);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://f.test/verify");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    // paymentPayload is sent as raw object (not base64)
    expect(body.paymentPayload).toEqual(payload);
    // paymentRequirements includes amount alias alongside maxAmountRequired
    expect(body.paymentRequirements.maxAmountRequired).toBe(REQUIREMENT.maxAmountRequired);
    expect(body.paymentRequirements.amount).toBe(REQUIREMENT.maxAmountRequired);
  });

  it("throws FacilitatorError on HTTP error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(400, "Bad Request")
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    await expect(client.verify(mockPermitPaymentPayload(), REQUIREMENT))
      .rejects.toThrow(FacilitatorError);
  });

  it("FacilitatorError carries status code", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(503, "Service Unavailable")
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    try {
      await client.verify(mockPermitPaymentPayload(), REQUIREMENT);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FacilitatorError);
      expect((err as FacilitatorError).statusCode).toBe(503);
    }
  });

  it("throws PaymentTimeoutError when request is aborted", async () => {
    const fetchFn = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        // Simulate abort
        (init?.signal as AbortSignal)?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const client = new FacilitatorClient({
      facilitatorUrl: "https://f.test",
      fetchFn,
      timeoutMs: 1,
    });

    await expect(client.verify(mockPermitPaymentPayload(), REQUIREMENT))
      .rejects.toThrow(PaymentTimeoutError);
  });

  it("routes base-sepolia to testnet facilitator URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFetchResponse(200, { isValid: true }));
    const client = new FacilitatorClient({ fetchFn });
    const payload = mockPermitPaymentPayload(); // network: base-sepolia

    await client.verify(payload, REQUIREMENT);

    const [url] = fetchFn.mock.calls[0];
    expect(url).toMatch("sbc-x402-facilitator.fly.dev");
  });
});

describe("FacilitatorClient.settle", () => {
  it("returns success:true with txHash", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { success: true, txHash: "0xdeadbeef" })
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    const result = await client.settle(mockPermitPaymentPayload(), REQUIREMENT);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xdeadbeef");
  });

  it("sends paymentPayload as raw object and paymentRequirements with amount field", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { success: true })
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });
    const payload = mockPermitPaymentPayload();

    await client.settle(payload, REQUIREMENT);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://f.test/settle");
    const body = JSON.parse(init.body);
    expect(body.paymentPayload).toEqual(payload);
    expect(body.paymentRequirements.amount).toBe(REQUIREMENT.maxAmountRequired);
  });

  it("throws FacilitatorError on HTTP 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(500, "Internal Error")
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    await expect(client.settle(mockPermitPaymentPayload(), REQUIREMENT))
      .rejects.toThrow(FacilitatorError);
  });

  it("handles 'transaction' field as alias for txHash", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { success: true, transaction: "0xabc123" })
    );
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    const result = await client.settle(mockPermitPaymentPayload(), REQUIREMENT);
    // The client itself doesn't normalize — caller does. Just check it returns the raw response.
    expect(result.transaction).toBe("0xabc123");
  });
});

describe("FacilitatorClient.isHealthy", () => {
  it("returns true when /health is ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFetchResponse(200, "ok"));
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    expect(await client.isHealthy()).toBe(true);
  });

  it("returns false when /health returns non-ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFetchResponse(503, "down"));
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    expect(await client.isHealthy()).toBe(false);
  });

  it("returns false on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new FacilitatorClient({ facilitatorUrl: "https://f.test", fetchFn });

    expect(await client.isHealthy()).toBe(false);
  });
});
