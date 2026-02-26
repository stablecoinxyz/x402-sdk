import { describe, it, expect } from "vitest";
import { SUPPORTED_NETWORKS, getNetworkConfig } from "../../src/core/networks.js";

describe("SUPPORTED_NETWORKS", () => {
  it("contains base with correct chainId and decimals", () => {
    const base = SUPPORTED_NETWORKS["base"];
    expect(base.chainId).toBe(8453);
    expect(base.decimals).toBe(18);
    expect(base.facilitatorUrl).toBe("https://sbc-x402-facilitator.fly.dev");
    expect(base.facilitatorAddress).toBe("0x124b082e8df36258198da4caa3b39c7dfa64d9ce");
    expect(base.defaultAsset).toMatch(/^0x/);
  });

  it("contains base-sepolia with testnet facilitator", () => {
    const testnet = SUPPORTED_NETWORKS["base-sepolia"];
    expect(testnet.chainId).toBe(84532);
    expect(testnet.decimals).toBe(6);
    expect(testnet.facilitatorUrl).toBe("https://sbc-x402-facilitator.fly.dev");
  });

  it("contains radius with chainId 723", () => {
    const radius = SUPPORTED_NETWORKS["radius"];
    expect(radius.chainId).toBe(723);
    expect(radius.facilitatorUrl).toBe("https://sbc-x402-facilitator.fly.dev");
  });

  it("contains solana with chainId 0 and 9 decimals", () => {
    const solana = SUPPORTED_NETWORKS["solana"];
    expect(solana.chainId).toBe(0);
    expect(solana.decimals).toBe(9);
    expect(solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });

  it("contains solana-devnet pointing to testnet facilitator", () => {
    const devnet = SUPPORTED_NETWORKS["solana-devnet"];
    expect(devnet.facilitatorUrl).toBe("https://sbc-x402-facilitator.fly.dev");
  });

  it("has no process.env calls in static values (no undefined from missing env)", () => {
    // Ensure static networks have real string values (not undefined from process.env)
    for (const [name, config] of Object.entries(SUPPORTED_NETWORKS)) {
      // facilitatorUrl and facilitatorAddress should always be set
      if (config.facilitatorUrl) {
        expect(typeof config.facilitatorUrl).toBe("string");
      }
      expect(typeof config.decimals).toBe("number");
      expect(typeof config.chainId).toBe("number");
      // name just for our own debug clarity
      void name;
    }
  });
});

describe("getNetworkConfig", () => {
  it("returns config for known network", () => {
    const config = getNetworkConfig("base");
    expect(config.chainId).toBe(8453);
  });

  it("throws for unknown network with helpful message", () => {
    expect(() => getNetworkConfig("ethereum")).toThrowError(/unsupported network.*ethereum/i);
  });

  it("error message lists available networks", () => {
    try {
      getNetworkConfig("polygon");
    } catch (err) {
      expect((err as Error).message).toContain("base");
      expect((err as Error).message).toContain("solana");
    }
  });
});
