/**
 * FacilitatorClient
 * Communicates with the x402 facilitator service (verify + settle).
 * No logger dependency — pure fetch.
 */

import type { PaymentPayload, PaymentRequirement, VerifyResponse, SettleResponse } from "./types.js";
import { SUPPORTED_NETWORKS } from "./networks.js";
import { FacilitatorError, PaymentTimeoutError } from "./errors.js";
import { withRetry } from "./retry.js";

export interface FacilitatorClientOptions {
  /** Override the facilitator URL for all networks. Defaults to network-specific config. */
  facilitatorUrl?: string;
  /** Fetch implementation (injectable for testing). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** API key for mainnet access. Required for Base, Radius, and Solana mainnet. Get yours at dashboard.stablecoin.xyz */
  apiKey?: string;
}

export class FacilitatorClient {
  private readonly overrideUrl: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signerCache = new Map<string, string | undefined>();

  private readonly apiKey: string | undefined;

  constructor(options: FacilitatorClientOptions = {}) {
    this.overrideUrl = options.facilitatorUrl;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.apiKey = options.apiKey;
  }

  /** Get the facilitator URL for a given network (accepts CAIP-2 or friendly name), respecting override. */
  getFacilitatorUrl(network: string): string {
    if (this.overrideUrl) {
      return normalizeLocalhost(this.overrideUrl);
    }
    // Support both CAIP-2 ("eip155:8453") and friendly names ("base")
    const config = SUPPORTED_NETWORKS[network] ?? SUPPORTED_NETWORKS[fromCAIP2(network)];
    return normalizeLocalhost(config?.facilitatorUrl ?? "https://x402.stablecoin.xyz");
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirement
  ): Promise<VerifyResponse> {
    return withRetry(
      async () => {
        const url = `${this.getFacilitatorUrl(paymentPayload.accepted.network)}/verify`;

        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
          },
          body: JSON.stringify({
            paymentPayload,
            paymentRequirements: {
              ...paymentRequirements,
              network: paymentPayload.accepted.network, // always CAIP-2 (e.g. "eip155:8453")
              amount: paymentRequirements.maxAmountRequired,
            },
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new FacilitatorError(`Facilitator verify failed: ${error}`, response.status);
        }

        try {
          return await response.json() as VerifyResponse;
        } catch {
          throw new FacilitatorError(`Facilitator verify returned non-JSON response`, response.status);
        }
      },
      "Facilitator verify",
      { maxAttempts: 3 }
    );
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirement
  ): Promise<SettleResponse> {
    return withRetry(
      async () => {
        const url = `${this.getFacilitatorUrl(paymentPayload.accepted.network)}/settle`;

        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
          },
          body: JSON.stringify({
            paymentPayload,
            paymentRequirements: {
              ...paymentRequirements,
              network: paymentPayload.accepted.network, // always CAIP-2 (e.g. "eip155:8453")
              amount: paymentRequirements.maxAmountRequired,
            },
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new FacilitatorError(`Facilitator settle failed: ${error}`, response.status);
        }

        try {
          return await response.json() as SettleResponse;
        } catch {
          throw new FacilitatorError(`Facilitator settle returned non-JSON response`, response.status);
        }
      },
      "Facilitator settle",
      { maxAttempts: 3 }
    );
  }

  /**
   * Discover the facilitator's actual signer (EOA) address for a given CAIP-2 network.
   * Queries /supported and caches the result per facilitator URL.
   * Returns undefined on any error — caller should fall back to requirement.facilitator.
   */
  async getSignerForNetwork(caip2Network: string): Promise<string | undefined> {
    const facilitatorUrl = this.getFacilitatorUrl(caip2Network);
    if (this.signerCache.has(facilitatorUrl)) {
      return this.signerCache.get(facilitatorUrl);
    }

    try {
      const response = await this.fetchFn(`${facilitatorUrl}/supported`);
      if (!response.ok) {
        this.signerCache.set(facilitatorUrl, undefined);
        return undefined;
      }

      const data = await response.json() as { signers?: Record<string, string[]> };
      // Try exact CAIP-2 match first, then namespace wildcard (e.g. "eip155:*")
      const namespace = caip2Network.split(":")[0] + ":*";
      const signers = data.signers?.[caip2Network] ?? data.signers?.[namespace] ?? [];
      const signer = signers[0];
      this.signerCache.set(facilitatorUrl, signer);
      return signer;
    } catch {
      this.signerCache.set(facilitatorUrl, undefined);
      return undefined;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchFn(
        `${normalizeLocalhost(this.overrideUrl ?? "https://x402.stablecoin.xyz")}/health`
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PaymentTimeoutError("Facilitator request");
      }
      throw error;
    } finally {
      clearTimeout(id);
    }
  }
}

function normalizeLocalhost(url: string): string {
  return url.replace(/^(https?:\/\/)localhost([:\/])/i, "$1127.0.0.1$2");
}

/** Reverse CAIP-2 → friendly network name. Returns original string if not found. */
function fromCAIP2(caip2: string): string {
  for (const [name, config] of Object.entries(SUPPORTED_NETWORKS)) {
    if (`eip155:${config.chainId}` === caip2) return name;
    if (name === "solana" && caip2 === "solana:mainnet-beta") return name;
    if (name === "solana-devnet" && caip2 === "solana:devnet") return name;
  }
  return caip2;
}

