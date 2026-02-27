/**
 * createX402Client — factory for EVM x402 payment client.
 *
 * Usage:
 *   const client = createX402Client({ signer: viemSignerAdapter(walletClient), network: 'base' })
 *   const response = await client.fetch('https://api.example.com/premium')
 */

import type { EvmSigner } from "./signer.js";
import { signPermit, signSbcPayment, signTransferAuthorization, getTokenBalance } from "./signing.js";
import { FacilitatorClient } from "../core/facilitator.js";
import { SUPPORTED_NETWORKS, toCAIP2 } from "../core/networks.js";
import { InsufficientBalanceError } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
import type {
  PaymentRequirement,
  PaymentRequirementsResponse,
  PaymentPayload,
  PaymentResult,
  PaymentResponse,
} from "../core/types.js";

export interface X402ClientOptions {
  /** Signer for signing payment payloads. */
  signer: EvmSigner;
  /** Network to use for payments (e.g. 'base', 'base-sepolia'). */
  network?: string;
  /** Override the facilitator URL. Defaults to network config. */
  facilitatorUrl?: string;
  /** Override the RPC URL (for raw eth_call). Defaults to network config. */
  rpcUrl?: string;
  /** Skip balance check before signing (faster, saves an RPC round-trip). Default: false. */
  skipBalanceCheck?: boolean;
  /** API key for mainnet access. Required for Base, Radius, and Solana mainnet. Get yours at dashboard.stablecoin.xyz */
  apiKey?: string;
  /** Custom fetch implementation (for testing). */
  fetchFn?: typeof fetch;
}

export interface X402Client {
  /**
   * Fetch a URL, automatically handling x402 payment if a 402 is received.
   * Returns the paid response on success.
   */
  fetch(
    url: string,
    options?: RequestInit & {
      /** Preferred network override (falls back to client's default network). */
      preferredNetwork?: string;
      /** Max amount willing to pay in USD (e.g. "0.05"). */
      maxAmount?: string;
    }
  ): Promise<Response & { paymentResult?: PaymentResult }>;
}

export function createX402Client(options: X402ClientOptions): X402Client {
  const { signer, network, facilitatorUrl, rpcUrl, skipBalanceCheck = false, fetchFn, apiKey } = options;
  const fetchImpl = fetchFn ?? (globalThis.fetch as typeof fetch);
  const facilitator = new FacilitatorClient({ facilitatorUrl, fetchFn: fetchImpl, apiKey });

  return {
    async fetch(url, requestOptions = {}) {
      const { preferredNetwork, maxAmount, ...fetchOptions } = requestOptions as typeof requestOptions & {
        preferredNetwork?: string;
        maxAmount?: string;
      };

      const normalizedUrl = normalizeLocalhost(url);

      // Step 1: Initial request
      const initialResponse = await withRetry(
        () => fetchImpl(normalizedUrl, fetchOptions),
        "Initial request",
        { maxAttempts: 3 }
      );

      if (initialResponse.status !== 402) {
        return initialResponse as Response & { paymentResult?: PaymentResult };
      }

      // Step 2: Parse requirements
      const bodyText = await initialResponse.text();
      const requirements = parsePaymentRequirements(bodyText, initialResponse.headers, normalizedUrl);
      const selected = selectRequirement(requirements, preferredNetwork ?? network, maxAmount);

      if (!selected) {
        throw new Error(
          `No suitable payment option found for networks: ${requirements.map((r) => r.network).join(", ")}`
        );
      }

      // Step 3: Optional balance check
      if (!skipBalanceCheck) {
        const networkConfig = SUPPORTED_NETWORKS[selected.network];
        if (networkConfig?.rpcUrl || rpcUrl) {
          const rpcEndpoint = rpcUrl ?? networkConfig.rpcUrl;
          const balance = await getTokenBalance(rpcEndpoint, selected.asset, signer.address, fetchImpl);
          if (balance < BigInt(selected.maxAmountRequired)) {
            throw new InsufficientBalanceError(balance.toString(), selected.maxAmountRequired);
          }
        }
      }

      // Step 4: Discover facilitator signer, then sign payment payload
      const caip2 = toCAIP2(selected.network);
      const facilitatorSigner = await facilitator.getSignerForNetwork(caip2);
      const paymentPayload = await buildPaymentPayload(signer, selected, rpcUrl, fetchImpl, facilitatorSigner);

      // Step 5: Re-fetch with payment header — server handles verify+settle
      const paymentHeader = toBase64(JSON.stringify(paymentPayload));
      const paidResponse = await withRetry(
        async () => {
          const resp = await fetchImpl(normalizedUrl, {
            ...fetchOptions,
            headers: {
              ...(fetchOptions.headers as Record<string, string>),
              "PAYMENT-SIGNATURE": paymentHeader,
              "X-PAYMENT": paymentHeader, // V1 backward compat
            },
          });
          if (resp.status === 402) {
            const body = await resp.clone().text().catch(() => "");
            throw new Error(`Received 402 after payment: ${body}`);
          }
          return resp;
        },
        "Paid request",
        { maxAttempts: 3 }
      );

      const paymentResult: PaymentResult = {
        success: paidResponse.ok,
        txHash: undefined as string | undefined,
        amountPaid: selected.maxAmountRequired,
        network: selected.network,
      };

      // Parse PAYMENT-RESPONSE header if present
      const paymentResponseHeader = paidResponse.headers.get("PAYMENT-RESPONSE") || paidResponse.headers.get("payment-response");
      if (paymentResponseHeader) {
        try {
          const decoded = fromBase64(paymentResponseHeader);
          const confirmation = JSON.parse(decoded) as PaymentResponse;
          if (confirmation.transaction) paymentResult.txHash = confirmation.transaction;
          if (confirmation.network) paymentResult.network = confirmation.network;
        } catch {
          // ignore parse errors
        }
      }

      return Object.assign(paidResponse, { paymentResult });
    },
  };
}

// ---- Internal helpers ----

async function buildPaymentPayload(
  signer: EvmSigner,
  requirement: PaymentRequirement,
  rpcUrlOverride?: string,
  fetchFn?: typeof fetch,
  /** Actual facilitator EOA (from /supported). Falls back to requirement.facilitator. */
  facilitatorSignerAddress?: string
): Promise<PaymentPayload> {
  const isSbcNetwork =
    requirement.network === "base" ||
    requirement.network === "base-sepolia" ||
    requirement.network === "radius" ||
    requirement.network === "radius-testnet";

  const networkConfig = SUPPORTED_NETWORKS[requirement.network];
  // Use discovered EOA first, then requirement hint, then static config fallback
  const facilitatorAddress =
    facilitatorSignerAddress ??
    requirement.facilitator ??
    networkConfig?.facilitatorAddress ??
    "0x124b082e8df36258198da4caa3b39c7dfa64d9ce";

  if (isSbcNetwork) {
    // Permit: ERC-2612 (preferred — no pre-approval needed)
    const tokenName = requirement.extra?.name ?? "SBC";
    try {
      const { payload } = await signPermit(signer, {
        network: requirement.network,
        spender: facilitatorAddress,
        value: requirement.maxAmountRequired,
        tokenAddress: requirement.asset,
        tokenName,
        validForSeconds: requirement.maxTimeoutSeconds,
        rpcUrlOverride,
        fetchFn,
      });

      return {
        accepted: { network: toCAIP2(requirement.network), scheme: requirement.scheme },
        payload,
      };
    } catch {
      // Fallback: SBC Payment (legacy pre-approval flow)
      const { payload } = await signSbcPayment(signer, {
        network: requirement.network,
        to: requirement.payTo,
        amount: requirement.maxAmountRequired,
        facilitatorAddress,
        validForSeconds: requirement.maxTimeoutSeconds,
      });

      return {
        accepted: { network: toCAIP2(requirement.network), scheme: requirement.scheme },
        payload,
      };
    }
  }

  // EIP-3009 TransferWithAuthorization (for USDC etc.)
  const tokenName = requirement.extra?.name ?? "USD Coin";
  const tokenVersion = requirement.extra?.version ?? "2";

  const { payload } = await signTransferAuthorization(signer, {
    network: requirement.network,
    to: requirement.payTo,
    value: requirement.maxAmountRequired,
    assetAddress: requirement.asset,
    tokenName,
    tokenVersion,
    validForSeconds: requirement.maxTimeoutSeconds,
  });

  return {
    accepted: { network: toCAIP2(requirement.network), scheme: requirement.scheme },
    payload,
  };
}

function parsePaymentRequirements(
  body: string,
  headers: Headers,
  url: string
): PaymentRequirement[] {
  let parsed: PaymentRequirementsResponse;

  // V2: PAYMENT-REQUIRED header (base64-encoded JSON)
  const header = headers.get("PAYMENT-REQUIRED") ?? headers.get("payment-required");
  if (header) {
    try {
      parsed = JSON.parse(fromBase64(header)) as PaymentRequirementsResponse;
    } catch {
      parsed = parseBody(body, url);
    }
  } else {
    parsed = parseBody(body, url);
  }

  if (!Array.isArray(parsed.accepts) || parsed.accepts.length === 0) {
    throw new Error(
      `x402: 402 response from ${url} missing valid "accepts" array`
    );
  }

  return parsed.accepts;
}

function parseBody(body: string, url: string): PaymentRequirementsResponse {
  try {
    return JSON.parse(body) as PaymentRequirementsResponse;
  } catch {
    throw new Error(
      `x402: API at ${url} returned 402 but body is not valid JSON. ` +
      `Received: ${body.slice(0, 200)}`
    );
  }
}

function selectRequirement(
  requirements: PaymentRequirement[],
  preferredNetwork?: string,
  maxAmount?: string
): PaymentRequirement | null {
  const supported = requirements.filter((r) => SUPPORTED_NETWORKS[r.network]);

  let filtered = supported;
  if (maxAmount) {
    filtered = supported.filter((r) => {
      const decimals = SUPPORTED_NETWORKS[r.network]?.decimals ?? 6;
      return BigInt(r.maxAmountRequired) <= usdToAtomic(maxAmount, decimals);
    });
  }

  if (filtered.length === 0) return null;

  if (preferredNetwork) {
    const preferred = filtered.find((r) => r.network === preferredNetwork);
    if (preferred) return preferred;
  }

  // Prefer testnet for safety, then cheapest
  const testnet = filtered.find((r) => r.network.includes("sepolia") || r.network.includes("testnet"));
  if (testnet) return testnet;

  return filtered.sort((a, b) => Number(BigInt(a.maxAmountRequired) - BigInt(b.maxAmountRequired)))[0];
}

function usdToAtomic(usdAmount: string, decimals: number): bigint {
  const parts = usdAmount.split(".");
  let fractional = parts[1] ?? "";
  fractional = fractional.length > decimals
    ? fractional.slice(0, decimals)
    : fractional.padEnd(decimals, "0");
  return BigInt((parts[0] + fractional).replace(/^0+(?=\d)/, "") || "0");
}

function normalizeLocalhost(url: string): string {
  return url.replace(/^(https?:\/\/)localhost([:\/])/i, "$1127.0.0.1$2");
}

function toBase64(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str).toString("base64");
  }
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64").toString("utf-8");
  }
  return decodeURIComponent(
    Array.from(atob(str))
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
}
