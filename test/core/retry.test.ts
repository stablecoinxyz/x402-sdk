import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../src/core/retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Success cases ----

  it("returns result immediately when fn succeeds on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, "test-op");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET connection failed"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, "test-op", { initialDelay: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on last attempt after multiple retryable failures", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("last-chance");

    const promise = withRetry(fn, "test-op", { maxAttempts: 3, initialDelay: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("last-chance");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ---- Non-retryable errors throw immediately ----

  it("throws immediately on non-retryable error without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Signature verification failed"));
    // Attach .catch() before running timers to prevent unhandled rejection
    const result = withRetry(fn, "test-op", { maxAttempts: 3 }).catch((e: unknown) => e as Error);
    await vi.runAllTimersAsync();
    const err = await result;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Signature verification failed");
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it("treats custom retryable errors list exclusively — default errors not retried", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("MY_CUSTOM_RETRY"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, "test-op", {
      retryableErrors: ["MY_CUSTOM_RETRY"],
      initialDelay: 10,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ---- Exhaustion ----

  it("exhausts all attempts on persistent retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const result = withRetry(fn, "test-op", { maxAttempts: 3, initialDelay: 10 }).catch((e: unknown) => e as Error);
    await vi.runAllTimersAsync();
    const err = await result;

    expect(err.message).toBe("ETIMEDOUT");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects custom maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = withRetry(fn, "test-op", { maxAttempts: 5, initialDelay: 10 }).catch((e) => e as Error);
    await vi.runAllTimersAsync();
    await result;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  // ---- Error name matching ----

  it("matches on error.name (NETWORK_ERROR name)", async () => {
    const err = new Error("connection lost");
    err.name = "NETWORK_ERROR";
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("recovered");

    const promise = withRetry(fn, "test-op", { initialDelay: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ---- Backoff ----

  it("applies exponential backoff: second delay doubles the first", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const delays: number[] = [];

    const origSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms, ...args) => {
      if (typeof ms === "number" && ms > 0) delays.push(ms);
      return origSetTimeout(cb as () => void, 0, ...args);
    });

    const result = withRetry(fn, "test-op", {
      maxAttempts: 3,
      initialDelay: 100,
      maxDelay: 10_000,
      backoffMultiplier: 2,
    }).catch(() => {});

    await vi.runAllTimersAsync();
    await result;
    spy.mockRestore();

    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
  });

  it("caps delay at maxDelay", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const delays: number[] = [];

    const origSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms, ...args) => {
      if (typeof ms === "number" && ms > 0) delays.push(ms);
      return origSetTimeout(cb as () => void, 0, ...args);
    });

    const result = withRetry(fn, "test-op", {
      maxAttempts: 5,
      initialDelay: 5000,
      maxDelay: 6000,
      backoffMultiplier: 3,
    }).catch(() => {});

    await vi.runAllTimersAsync();
    await result;
    spy.mockRestore();

    // All delays after the first should be capped at maxDelay = 6000
    for (const d of delays.slice(1)) {
      expect(d).toBeLessThanOrEqual(6000);
    }
  });
});
