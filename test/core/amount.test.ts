import { describe, it, expect } from "vitest";
import { usdToAtomic, knownTokenDecimals } from "../../src/core/amount.js";

describe("usdToAtomic", () => {
  it("converts with the given decimals", () => {
    expect(usdToAtomic("0.05", 6)).toBe(50_000n);
    expect(usdToAtomic("1", 18)).toBe(10n ** 18n);
    expect(usdToAtomic("0", 6)).toBe(0n);
  });

  it("drops fractional digits beyond the token's decimals (rounds the cap down)", () => {
    expect(usdToAtomic("0.1234567", 6)).toBe(123_456n);
  });

  it.each(["0x10", "1.5.5", "-1", "1e6", "", ".5", "5.", " 1", "1_000", "Infinity"])("throws on %j", (v) => {
    expect(() => usdToAtomic(v, 6)).toThrow(/maxAmount must be a non-negative decimal string/);
  });
});

describe("knownTokenDecimals", () => {
  it("reads a token's own decimals, case-insensitively, not the network's", () => {
    expect(knownTokenDecimals("base", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913")).toBe(6);
    expect(knownTokenDecimals("base", "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798")).toBe(18);
  });

  it("is undefined for a token or network it does not know", () => {
    expect(knownTokenDecimals("base", "0x9999999999999999999999999999999999999999")).toBeUndefined();
    expect(knownTokenDecimals("nope", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBeUndefined();
  });
});
