/**
 * Supported network configurations for x402
 * Static defaults — no process.env at module load time.
 * Override per-network at runtime by passing rpcUrl/facilitatorUrl to client constructors.
 */

import type { NetworkConfig } from "./types.js";

// EIP-712 domains, matching the facilitator's token table (`resolveToken` in x402-facilitator
// src/config.ts). Names are each contract's on-chain name(). SBC exposes no version(); "1" is
// the domain version the facilitator and the agent platform sign with.
const SBC_DOMAIN = { name: "Stable Coin", version: "1" };

// `decimals` on each token entry is the contract's on-chain decimals(), read 2026-11-02 with
// `cast call <token> "decimals()(uint8)" --rpc-url <rpcUrl>` against each network's rpcUrl below.

// Sui. The SBC facilitator settles native Circle USDC on Sui as x402 v2 `exact` payments the
// payer signs and the facilitator submits (gasless: no fee payer). The paywall never talks to
// the chain itself; `rpcUrl` is the public fullnode, recorded for reference only.
// Coin types match the facilitator's allowlist and agent-payments apps/web/lib/sui-networks.ts.
export const SUI_NETWORKS = {
  sui: {
    caip2: "sui:mainnet",
    usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  },
  "sui-testnet": {
    caip2: "sui:testnet",
    usdc: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  },
} as const;

export function isSuiNetwork(network: string): network is keyof typeof SUI_NETWORKS {
  return Object.prototype.hasOwnProperty.call(SUI_NETWORKS, network);
}

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
    tokens: [
      { address: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798", ...SBC_DOMAIN, decimals: 18 },
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", decimals: 6 },
    ],
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
    tokens: [
      { address: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16", ...SBC_DOMAIN, decimals: 6 },
      { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6 },
    ],
  },
  radius: {
    chainId: 723487,
    name: "Radius",
    rpcUrl: "https://rpc.radiustech.xyz",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb", // SBC on Radius (6 decimals)
    explorerUrl: "https://network.radiustech.xyz",
    decimals: 6,
    tokenName: "Stable Coin",
    tokens: [
      { address: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb", ...SBC_DOMAIN, decimals: 6 },
    ],
  },
  "radius-testnet": {
    chainId: 72344,
    name: "Radius Testnet",
    rpcUrl: "https://rpc.testnet.radiustech.xyz",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    defaultAsset: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb", // SBC on Radius Testnet (6 decimals)
    explorerUrl: "https://testnet.radiustech.xyz",
    decimals: 6,
    tokenName: "Stable Coin",
    tokens: [
      { address: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb", ...SBC_DOMAIN, decimals: 6 },
    ],
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
  sui: {
    chainId: 0, // Not applicable for Sui
    name: "Sui",
    rpcUrl: "https://fullnode.mainnet.sui.io:443",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "", // No fee payer: the payer signs a gasless USDC transfer
    defaultAsset: SUI_NETWORKS.sui.usdc,
    explorerUrl: "https://suiscan.xyz/mainnet",
    decimals: 6,
    tokenName: "",
  },
  "sui-testnet": {
    chainId: 0,
    name: "Sui Testnet",
    rpcUrl: "https://fullnode.testnet.sui.io:443",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    facilitatorAddress: "",
    defaultAsset: SUI_NETWORKS["sui-testnet"].usdc,
    explorerUrl: "https://suiscan.xyz/testnet",
    decimals: 6,
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
  if (isSuiNetwork(network)) return SUI_NETWORKS[network].caip2;
  return `eip155:${config.chainId}`;
}
