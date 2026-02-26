/**
 * Supported network configurations for x402
 * Static defaults — no process.env at module load time.
 * Override per-network at runtime by passing rpcUrl/facilitatorUrl to client constructors.
 */

import type { NetworkConfig } from "./types.js";

export const SUPPORTED_NETWORKS: Record<string, NetworkConfig> = {
  base: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798", // SBC on Base (18 decimals)
    explorerUrl: "https://basescan.org",
    decimals: 18,
    tokenName: "Stable Coin",
  },
  "base-sepolia": {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16", // SBC on Base Sepolia (6 decimals)
    explorerUrl: "https://sepolia.basescan.org",
    decimals: 6,
    tokenName: "Stable Coin",
  },
  radius: {
    chainId: 723,
    name: "Radius",
    rpcUrl: "", // Must be provided via client options
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "", // Must be provided via client options
    explorerUrl: "",
    decimals: 6,
    tokenName: "Stable Coin",
  },
  "radius-testnet": {
    chainId: 72344,
    name: "Radius Testnet",
    rpcUrl: "", // Must be provided via client options
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "", // Must be provided via client options
    explorerUrl: "",
    decimals: 6,
    tokenName: "Stable Coin",
  },
  solana: {
    chainId: 0, // Not applicable for Solana
    name: "Solana",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K",
    defaultAsset: "", // Set via client options
    explorerUrl: "https://explorer.solana.com",
    decimals: 9,
    tokenName: "",
  },
  "solana-devnet": {
    chainId: 0,
    name: "Solana Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K",
    defaultAsset: "",
    explorerUrl: "https://explorer.solana.com?cluster=devnet",
    decimals: 9,
    tokenName: "",
  },
};

export function getNetworkConfig(network: string): NetworkConfig {
  const config = SUPPORTED_NETWORKS[network];
  if (!config) {
    throw new Error(`Unsupported network: "${network}". Supported: ${Object.keys(SUPPORTED_NETWORKS).join(", ")}`);
  }
  return config;
}

/** Convert friendly network name to CAIP-2 identifier expected by the facilitator. */
export function toCAIP2(network: string): string {
  const config = SUPPORTED_NETWORKS[network];
  if (!config) {
    throw new Error(`Unsupported network: "${network}"`);
  }
  if (network === "solana") return "solana:mainnet-beta";
  if (network === "solana-devnet") return "solana:devnet";
  return `eip155:${config.chainId}`;
}
