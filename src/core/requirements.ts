/**
 * Payment requirements the paywall middlewares advertise in their 402 replies.
 *
 * EVM requirements use the x402 v2 Permit2 shape the SBC facilitator settles: a CAIP-2
 * `network`, `amount`, and `extra: { assetTransferMethod: "permit2", name, version }`. The
 * facilitator rejects a payment unless the buyer's echoed `accepted` offer equals these
 * fields (x402-facilitator src/routes/verify.ts and settle.ts), so the EIP-712 name and
 * version must be the token's real ones. Solana requirements are unchanged.
 */

import { SUPPORTED_NETWORKS, isSuiNetwork, toCAIP2 } from "./networks.js";
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
  /** `false` = verify only. Refused on EVM: see resolveRequirement. */
  settle?: boolean;
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
const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
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
  if (isSuiNetwork(opt.network)) {
    if (opt.tokenName !== undefined || opt.tokenVersion !== undefined) {
      throw new Error(`${label}: tokenName/tokenVersion apply to EVM networks only, not ${opt.network}`);
    }
    // Same reason as EVM below: Sui verify only simulates the signed transaction and consumes
    // nothing, so one payment would pass verify until its epoch window closes.
    if (opt.settle === false) {
      throw new Error(`${label}: settle: false (verify-only) is not supported on Sui networks; one payment could be replayed`);
    }
    // The agent platform refuses a Sui offer whose payTo is not a full 32-byte address
    // (agent-payments apps/web/lib/sui-x402.ts selectSuiRequirement).
    if (!SUI_ADDRESS.test(opt.payTo)) {
      throw new Error(`${label}: payTo must be a full Sui address (0x + 64 hex) on ${opt.network}`);
    }
    if (!ATOMIC_AMOUNT.test(opt.amount)) {
      throw new Error(`${label}: amount must be a positive integer string in atomic units`);
    }
    return base;
  }
  if (!isEvmNetwork(opt.network)) {
    if (opt.tokenName !== undefined || opt.tokenVersion !== undefined) {
      throw new Error(`${label}: tokenName/tokenVersion apply to EVM networks only, not ${opt.network}`);
    }
    return base;
  }

  // Verify-only cannot be made safe on EVM: the facilitator's verify does not consume the
  // Permit2 nonce or cap the deadline, so one signed payment would pass verify forever and
  // the handler would be served without limit while nothing settles.
  if (opt.settle === false) {
    throw new Error(`${label}: settle: false (verify-only) is not supported on EVM networks; one payment could be replayed without limit`);
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
 * carry several offers (SBC and USDC on Base). On EVM the buyer's echoed `accepted` must
 * name this entry's asset, payTo and amount, so the facilitator is never handed
 * requirements for a different offer than the one signed, and a payment that cannot pass
 * the facilitator's envelope check is refused here without spending a facilitator call.
 * Solana entries match on network, as in 0.4.1.
 */
export function matchRequirement<T extends { resolved: ResolvedRequirement }>(
  entries: T[],
  accepted: { network?: unknown; asset?: unknown; payTo?: unknown; amount?: unknown } | undefined
): T | undefined {
  const onNetwork = entries.filter((e) => e.resolved.caip2 === accepted?.network);
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  return onNetwork.find(
    (e) =>
      (!e.resolved.token && !isSuiNetwork(e.resolved.network)) ||
      (same(accepted?.asset, e.resolved.asset) &&
        same(accepted?.payTo, e.resolved.payTo) &&
        accepted?.amount === e.resolved.amount)
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
  if (isSuiNetwork(r.network)) {
    // The shape the SBC facilitator settles and the agent platform pays (agent-payments
    // apps/web/app/api/demo/seller/route.ts suiDemoSeller): CAIP-2 network, `amount`, no
    // facilitator address and no fee payer. The facilitator requires the buyer's echoed
    // `accepted` to equal these on network, amount, asset and payTo
    // (x402-facilitator src/sui/sui-exact.ts suiAcceptanceBindsRequirements).
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
      extra: {},
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

/**
 * The reply for a settlement that did not succeed but may have moved money, on any network,
 * or undefined when the failure is terminal (e.g. mined and reverted) and the usual 402
 * applies. A 402 here would invite the buyer to sign and pay again.
 *
 * - `settlement_pending`: the facilitator broadcast the transaction and does not yet know the
 *   outcome (x402-facilitator src/routes/settle.ts answers this on EVM, Solana and Sui). 202
 *   with the transaction, the shape agent-payments' Sui demo seller returns, so the buyer
 *   reconciles it instead of re-signing.
 * - `duplicate_settlement` (Sui only today): this exact signed transaction already executed on chain. 409 with
 *   the digest, and the resource is NOT served: the facilitator reports a given payment's
 *   success at most once, so serving here would let anyone holding a copy of a paid header
 *   replay it for free. The SDK never retries a settle (FacilitatorClient.settle), so
 *   this means someone else submitted the same signed bytes. Known facilitator defect, being
 *   fixed there: at x402-facilitator f3341d3 (src/routes/settle.ts:523-533) it also says
 *   duplicate_settlement for a broadcast it made itself and lost the receipt of, so an honest
 *   buyer can be refused; the digest lets them prove the payment.
 */
export function unsettledReply(
  result: { errorReason?: string; transaction?: string; txHash?: string }
): { status: number; body: Record<string, unknown> } | undefined {
  // The facilitator fills the transaction on both outcomes; if it ever does not, the payment may
  // still have moved, so the reply stays non-402 and simply carries no digest.
  const txHash = result.transaction || result.txHash || undefined;
  if (result.errorReason === "settlement_pending") {
    return { status: 202, body: { pending: true, reason: "settlement_pending", payment: { txHash } } };
  }
  if (result.errorReason === "duplicate_settlement") {
    return {
      status: 409,
      body: { error: "Payment already settled", reason: "duplicate_settlement", payment: { txHash } },
    };
  }
  return undefined;
}

/**
 * The reply when the settle call itself failed (timeout, dropped connection), on any network.
 * The facilitator may have broadcast the transaction, so the outcome is unknown: 504, never 402.
 */
export function settleErrorReply(message: string): { status: number; body: Record<string, unknown> } {
  return { status: 504, body: { error: "settlement_unknown", detail: message, outcome: "unknown" } };
}

/** The facilitator's /verify reason for a Sui transaction that already executed on chain. */
export const SUI_ALREADY_EXECUTED = "invalid_exact_sui_payload_already_executed";

/**
 * The reply for a Sui /verify refusal that means the money already moved, or undefined when
 * the usual 402 applies. /verify refuses a transaction that already executed; a 402 would tell
 * a buyer who is retrying after a lost response to sign and pay again. 409, resource not
 * served, for the same reason as `duplicate_settlement` in `unsettledReply`.
 */
export function suiVerifyRejectReply(
  network: string,
  result: { invalidReason?: string }
): { status: number; body: Record<string, unknown> } | undefined {
  if (!isSuiNetwork(network) || result.invalidReason !== SUI_ALREADY_EXECUTED) return undefined;
  return { status: 409, body: { error: "Payment already settled", reason: SUI_ALREADY_EXECUTED } };
}
