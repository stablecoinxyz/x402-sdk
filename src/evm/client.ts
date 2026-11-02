/**
 * createX402Client — factory for EVM x402 payment client.
 *
 * Usage:
 *   const client = createX402Client({ signer: viemSignerAdapter(walletClient), network: 'base' })
 *   const response = await client.fetch('https://api.example.com/premium')
 */

import type { EvmSigner } from "./signer.js";
import { signPermit2Payment, getTokenBalance } from "./signing.js";
import { SUPPORTED_NETWORKS } from "../core/networks.js";
import { fromCAIP2 } from "../core/facilitator.js";
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
  /** @deprecated Unused: the seller talks to the facilitator, the client never does. */
  facilitatorUrl?: string;
  /** Override the RPC URL (balance, Permit2 allowance and token nonce reads). Defaults to network config. */
  rpcUrl?: string;
  /** Skip balance check before signing (faster, saves an RPC round-trip). Default: false. */
  skipBalanceCheck?: boolean;
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
  const { signer, network, rpcUrl, skipBalanceCheck = false, fetchFn } = options;
  const fetchImpl = fetchFn ?? (globalThis.fetch as typeof fetch);

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
      const choice = selectRequirement(requirements, preferredNetwork ?? network, maxAmount);

      if (!choice) {
        throw new Error(
          `No suitable payment option found for networks: ${requirements.map((r) => r.network).join(", ")}`
        );
      }
      // `selected` is keyed by the friendly network name; `offer` is the seller's entry as sent.
      const { selected, offer } = choice;
      const amount = selected.amount ?? selected.maxAmountRequired;

      // Step 3: Optional balance check
      if (!skipBalanceCheck) {
        const networkConfig = SUPPORTED_NETWORKS[selected.network];
        if (networkConfig?.rpcUrl || rpcUrl) {
          const rpcEndpoint = rpcUrl ?? networkConfig.rpcUrl;
          const balance = await getTokenBalance(rpcEndpoint, selected.asset, signer.address, fetchImpl);
          if (balance < BigInt(amount)) {
            throw new InsufficientBalanceError(balance.toString(), amount);
          }
        }
      }

      // Step 4: Sign the Permit2 payment for the offer as the seller sent it
      const paymentPayload = await buildPaymentPayload(signer, selected.network, offer, normalizedUrl, rpcUrl, fetchImpl);

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
        amountPaid: amount,
        network: selected.network,
      };

      // 202: the seller's facilitator broadcast the payment and does not know the outcome yet
      // (paywall >= 0.5.1). Not a success; the txHash is what to reconcile, not a reason to pay again.
      if (paidResponse.status === 202) {
        paymentResult.success = false;
        paymentResult.pending = true;
        const body = await paidResponse.clone().json().catch(() => undefined) as { payment?: { txHash?: string } } | undefined;
        if (body?.payment?.txHash) paymentResult.txHash = body.payment.txHash;
      }

      // Parse the receipt header if present: PAYMENT-RESPONSE (x402 v2) or X-PAYMENT-RESPONSE (v1)
      const paymentResponseHeader = paidResponse.headers.get("PAYMENT-RESPONSE") ?? paidResponse.headers.get("X-PAYMENT-RESPONSE");
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
  network: string,
  offer: PaymentRequirement,
  resource: string,
  rpcUrlOverride?: string,
  fetchFn?: typeof fetch
): Promise<PaymentPayload> {
  const { payload, extensions } = await signPermit2Payment(signer, { network, offer, rpcUrlOverride, fetchFn });
  return {
    x402Version: 2,
    resource,
    // Echo the offer exactly: the seller matches the payment to an offer by these fields and
    // the facilitator refuses a payment whose echo differs from the requirements.
    accepted: {
      scheme: offer.scheme,
      network: offer.network,
      amount: offer.amount ?? offer.maxAmountRequired,
      asset: offer.asset,
      payTo: offer.payTo,
      extra: offer.extra,
    },
    payload,
    ...(extensions ? { extensions } : {}),
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
): { selected: PaymentRequirement; offer: PaymentRequirement } | null {
  // EVM offers only, keyed by friendly network name: paywall >= 0.5 advertises CAIP-2
  // ("eip155:8453"), older sellers the friendly name. Solana offers are never this client's.
  const evm = requirements
    .map((offer) => ({ offer, selected: { ...offer, network: SUPPORTED_NETWORKS[offer.network] ? offer.network : fromCAIP2(offer.network) } }))
    .filter(({ selected }) => (SUPPORTED_NETWORKS[selected.network]?.chainId ?? 0) > 0);

  // The SBC facilitator settles only Permit2 on EVM. A seller advertising only the legacy
  // ERC-2612 shape (paywall < 0.5) cannot be paid; say so instead of signing something unsettleable.
  const supported = evm.filter(({ offer }) => offer.extra?.assetTransferMethod === "permit2");
  if (evm.length > 0 && supported.length === 0) {
    throw new Error(
      "x402: the seller offers no Permit2 payment option (extra.assetTransferMethod \"permit2\"). " +
      "It likely runs paywall < 0.5; the SBC facilitator settles only Permit2 on EVM."
    );
  }

  const atomic = (r: PaymentRequirement) => BigInt(r.amount ?? r.maxAmountRequired);
  let filtered = supported;
  if (maxAmount) {
    filtered = supported.filter(({ selected }) => {
      const decimals = SUPPORTED_NETWORKS[selected.network]?.decimals ?? 6;
      return atomic(selected) <= usdToAtomic(maxAmount, decimals);
    });
  }

  if (filtered.length === 0) return null;

  if (preferredNetwork) {
    const preferred = filtered.find(({ selected }) => selected.network === preferredNetwork);
    if (preferred) return preferred;
  }

  // Prefer testnet for safety, then cheapest
  const testnet = filtered.find(({ selected }) => selected.network.includes("sepolia") || selected.network.includes("testnet"));
  if (testnet) return testnet;

  return filtered.sort((a, b) => Number(atomic(a.selected) - atomic(b.selected)))[0];
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
