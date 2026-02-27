/**
 * createSolanaX402Client — factory for Solana x402 payment client.
 *
 * Usage:
 *   const client = createSolanaX402Client({ signer: keypairSignerAdapter(keypair), network: 'solana' })
 *   const response = await client.fetch('https://api.example.com/premium')
 */

import type { SolanaSigner } from "./signer.js";
import { signSolanaPayment } from "./signing.js";
import { FacilitatorClient } from "../core/facilitator.js";
import { SUPPORTED_NETWORKS, toCAIP2 } from "../core/networks.js";
import { withRetry } from "../core/retry.js";
import type {
  PaymentRequirement,
  PaymentRequirementsResponse,
  PaymentPayload,
  PaymentResult,
  PaymentResponse,
  SettleResponse,
} from "../core/types.js";

export interface SolanaX402ClientOptions {
  /** Signer for signing payment payloads. */
  signer: SolanaSigner;
  /** Network to use (e.g. 'solana', 'solana-devnet'). */
  network?: string;
  /** Override the facilitator URL. Defaults to network config. */
  facilitatorUrl?: string;
  /** API key for mainnet access. Required for Solana mainnet. Get yours at dashboard.stablecoin.xyz */
  apiKey?: string;
  /** Custom fetch implementation (for testing). */
  fetchFn?: typeof fetch;
}

export interface SolanaX402Client {
  /**
   * Fetch a URL, automatically handling x402 payment if a 402 is received.
   */
  fetch(
    url: string,
    options?: RequestInit & {
      preferredNetwork?: string;
      maxAmount?: string;
    }
  ): Promise<Response & { paymentResult?: PaymentResult }>;
}

export function createSolanaX402Client(options: SolanaX402ClientOptions): SolanaX402Client {
  const { signer, network, facilitatorUrl, fetchFn, apiKey } = options;
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
          `No suitable Solana payment option found for networks: ${requirements.map((r) => r.network).join(", ")}`
        );
      }

      // Step 3: Sign payment
      const { payload: solanaPayload } = await signSolanaPayment(signer, {
        to: selected.payTo,
        amount: selected.maxAmountRequired,
        validForSeconds: selected.maxTimeoutSeconds,
      });

      const paymentPayload: PaymentPayload = {
        accepted: { network: toCAIP2(selected.network), scheme: selected.scheme },
        payload: solanaPayload,
      };

      // Step 4: Verify
      const verifyResult = await facilitator.verify(paymentPayload, selected);
      if (!verifyResult.isValid) {
        throw new Error(`Payment verification failed: ${verifyResult.invalidReason}`);
      }

      // Step 5: Settle
      const settleResult = await facilitator.settle(paymentPayload, selected);
      if (!settleResult.success) {
        throw new Error(`Payment settlement failed: ${settleResult.error ?? settleResult.errorReason}`);
      }

      const txHash = extractTxHash(settleResult);

      // Step 6: Re-fetch with payment header
      const paymentHeader = toBase64(JSON.stringify(paymentPayload));
      const paidResponse = await withRetry(
        async () => {
          const resp = await fetchImpl(normalizedUrl, {
            ...fetchOptions,
            headers: {
              ...(fetchOptions.headers as Record<string, string>),
              "PAYMENT-SIGNATURE": paymentHeader,
              "X-PAYMENT": paymentHeader,
            },
          });
          if (resp.status === 402) {
            throw new Error("Received 402 after payment");
          }
          return resp;
        },
        "Paid request",
        { maxAttempts: 3 }
      );

      const paymentResult: PaymentResult = {
        success: paidResponse.ok,
        txHash,
        amountPaid: selected.maxAmountRequired,
        network: selected.network,
      };

      const paymentResponseHeader =
        paidResponse.headers.get("PAYMENT-RESPONSE") ?? paidResponse.headers.get("payment-response");
      if (paymentResponseHeader) {
        try {
          const decoded = fromBase64(paymentResponseHeader);
          const confirmation = JSON.parse(decoded) as PaymentResponse;
          if (confirmation.transaction) paymentResult.txHash = confirmation.transaction;
          if (confirmation.network) paymentResult.network = confirmation.network;
        } catch {
          // ignore
        }
      }

      return Object.assign(paidResponse, { paymentResult });
    },
  };
}

// ---- Helpers ----

function parsePaymentRequirements(body: string, headers: Headers, url: string): PaymentRequirement[] {
  let parsed: PaymentRequirementsResponse;

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
    throw new Error(`x402: 402 response from ${url} missing valid "accepts" array`);
  }

  return parsed.accepts;
}

function parseBody(body: string, url: string): PaymentRequirementsResponse {
  try {
    return JSON.parse(body) as PaymentRequirementsResponse;
  } catch {
    throw new Error(`x402: API at ${url} returned 402 but body is not valid JSON.`);
  }
}

function selectRequirement(
  requirements: PaymentRequirement[],
  preferredNetwork?: string,
  maxAmount?: string
): PaymentRequirement | null {
  const solanaNetworks = ["solana", "solana-devnet"];
  const supported = requirements.filter((r) => solanaNetworks.includes(r.network));

  let filtered = supported;
  if (maxAmount) {
    filtered = supported.filter((r) => {
      const decimals = SUPPORTED_NETWORKS[r.network]?.decimals ?? 9;
      return BigInt(r.maxAmountRequired) <= usdToAtomic(maxAmount, decimals);
    });
  }

  if (filtered.length === 0) return null;

  if (preferredNetwork) {
    const preferred = filtered.find((r) => r.network === preferredNetwork);
    if (preferred) return preferred;
  }

  const devnet = filtered.find((r) => r.network.includes("devnet"));
  if (devnet) return devnet;

  return filtered.sort((a, b) => Number(BigInt(a.maxAmountRequired) - BigInt(b.maxAmountRequired)))[0];
}

function usdToAtomic(usdAmount: string, decimals: number): bigint {
  const parts = usdAmount.split(".");
  let fractional = parts[1] ?? "";
  fractional = fractional.length > decimals ? fractional.slice(0, decimals) : fractional.padEnd(decimals, "0");
  return BigInt((parts[0] + fractional).replace(/^0+(?=\d)/, "") || "0");
}

function extractTxHash(result: SettleResponse): string | undefined {
  return result.txHash ?? result.transaction;
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
