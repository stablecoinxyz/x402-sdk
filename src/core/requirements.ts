/**
 * Payment requirements the paywall middlewares advertise in their 402 replies.
 *
 * EVM requirements use the x402 v2 Permit2 shape the SBC facilitator settles: a CAIP-2
 * `network`, `amount`, and `extra: { assetTransferMethod: "permit2", name, version }`. The
 * facilitator rejects a payment unless the buyer's echoed `accepted` offer equals these
 * fields (x402-facilitator src/routes/verify.ts and settle.ts), so the EIP-712 name and
 * version must be the token's real ones. Solana requirements are unchanged.
 */

import { SUPPORTED_NETWORKS, toCAIP2 } from "./networks.js";
import type { EvmTokenInfo, PaymentRequirement } from "./types.js";

export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

export interface RequirementOptions {
  payTo: string;
  amount: string;
  network: string;
  asset?: string;
  description?: string;
  /** EIP-712 domain name of `asset`, needed only when it is not a token this SDK knows. */
  tokenName?: string;
  /** EIP-712 domain version of `asset`, needed only when it is not a token this SDK knows. */
  tokenVersion?: string;
}

/** A paywall entry resolved once, at construction, so misconfiguration fails at startup. */
export interface ResolvedRequirement {
  network: string;
  caip2: string;
  payTo: string;
  amount: string;
  asset: string;
  description?: string;
  /** Present on EVM entries only. */
  token?: Pick<EvmTokenInfo, "name" | "version">;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_AMOUNT = /^[1-9]\d*$/;

export function isEvmNetwork(network: string): boolean {
  return (SUPPORTED_NETWORKS[network]?.chainId ?? 0) > 0;
}

/**
 * Validate one paywall option and resolve its asset and EIP-712 domain.
 * Throws on an unsupported network, and for EVM on a malformed `payTo`, `amount` or
 * `asset`, or an asset whose domain is neither known nor given.
 */
export function resolveRequirement(opt: RequirementOptions, label: string): ResolvedRequirement {
  const config = SUPPORTED_NETWORKS[opt.network];
  if (!config) {
    throw new Error(`${label}: unsupported network "${opt.network}"`);
  }
  const asset = opt.asset ?? config.defaultAsset;
  const base: ResolvedRequirement = {
    network: opt.network,
    caip2: toCAIP2(opt.network),
    payTo: opt.payTo,
    amount: opt.amount,
    asset,
    description: opt.description,
  };
  if (!isEvmNetwork(opt.network)) {
    if (opt.tokenName !== undefined || opt.tokenVersion !== undefined) {
      throw new Error(`${label}: tokenName/tokenVersion apply to EVM networks only, not ${opt.network}`);
    }
    return base;
  }

  if (!EVM_ADDRESS.test(opt.payTo) || /^0x0{40}$/.test(opt.payTo)) {
    throw new Error(`${label}: payTo must be a non-zero 0x-prefixed 20-byte address on ${opt.network}`);
  }
  if (!ATOMIC_AMOUNT.test(opt.amount)) {
    throw new Error(`${label}: amount must be a positive integer string in atomic units`);
  }
  if (!EVM_ADDRESS.test(asset)) {
    throw new Error(`${label}: asset must be a 0x-prefixed 20-byte token address on ${opt.network}`);
  }

  const known = config.tokens?.find((t) => t.address.toLowerCase() === asset.toLowerCase());
  if (opt.tokenName !== undefined || opt.tokenVersion !== undefined) {
    if (!opt.tokenName || !opt.tokenVersion) {
      throw new Error(`${label}: tokenName and tokenVersion must be given together`);
    }
    if (known && (known.name !== opt.tokenName || known.version !== opt.tokenVersion)) {
      throw new Error(
        `${label}: ${asset} on ${opt.network} has EIP-712 domain "${known.name}" v${known.version}, not "${opt.tokenName}" v${opt.tokenVersion}`
      );
    }
    return { ...base, token: { name: opt.tokenName, version: opt.tokenVersion } };
  }
  if (!known) {
    throw new Error(
      `${label}: unknown token ${asset} on ${opt.network}; pass tokenName and tokenVersion (its EIP-712 domain)`
    );
  }
  return { ...base, token: { name: known.name, version: known.version } };
}

/**
 * Pick the paywall entry a payment is for. Network alone is not enough: one network can
 * carry several offers (SBC and USDC on Base). The buyer's echoed `accepted` names the
 * asset and payTo; an entry whose fields contradict the echo is never chosen, so the
 * facilitator is never handed requirements for a different offer than the one signed.
 */
export function matchRequirement<T extends { resolved: ResolvedRequirement }>(
  entries: T[],
  accepted: { network?: unknown; asset?: unknown; payTo?: unknown; amount?: unknown } | undefined
): T | undefined {
  const onNetwork = entries.filter((e) => e.resolved.caip2 === accepted?.network);
  if (onNetwork.length <= 1) return onNetwork[0];
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  return onNetwork.find(
    (e) =>
      same(accepted?.asset, e.resolved.asset) &&
      same(accepted?.payTo, e.resolved.payTo) &&
      (accepted?.amount === undefined || accepted.amount === e.resolved.amount)
  );
}

/** The `accepts[]` entry for one resolved option. */
export function buildRequirement(resource: string, r: ResolvedRequirement): PaymentRequirement {
  if (r.token) {
    return {
      scheme: "exact",
      network: r.caip2,
      amount: r.amount,
      maxAmountRequired: r.amount,
      resource,
      description: r.description,
      payTo: r.payTo,
      asset: r.asset,
      maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: "permit2", name: r.token.name, version: r.token.version },
    };
  }
  // Solana: unchanged from 0.4.1.
  const config = SUPPORTED_NETWORKS[r.network];
  return {
    scheme: "exact",
    network: r.network,
    maxAmountRequired: r.amount,
    resource,
    description: r.description,
    payTo: r.payTo,
    asset: r.asset,
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
    facilitator: config?.facilitatorAddress,
    extra: config?.tokenName ? { name: config.tokenName } : undefined,
  };
}

/**
 * The payer to report to the handler: the facilitator's recovered payer first, then the
 * legacy payload fields. A Permit2 payload has no `authorization.from`. The fallback is
 * whatever the buyer wrote in the payload and is not signature-checked.
 */
export function resolvePayer(verifyPayer: string | undefined, inner: unknown): string {
  if (verifyPayer && verifyPayer !== "unknown") return verifyPayer;
  const p = inner as { authorization?: { from?: string }; from?: string; permit2Authorization?: { from?: string } } | undefined;
  return p?.permit2Authorization?.from || p?.authorization?.from || p?.from || "unknown";
}
