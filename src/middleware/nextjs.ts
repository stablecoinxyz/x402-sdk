/**
 * withX402 — Next.js App Router wrapper for x402-gated route handlers.
 *
 * Usage (single network):
 *   export const GET = withX402({ payTo: '0x...', amount: '1000000', network: 'base' }, handler)
 *
 * Usage (multi-network):
 *   export const GET = withX402([
 *     { payTo: '0x...', amount: '1000000000000000', network: 'base' },
 *     { payTo: '2mSj...', amount: '1000000', network: 'solana' },
 *   ], handler)
 */

import { FacilitatorClient } from "../core/facilitator.js";
import { SUPPORTED_NETWORKS, toCAIP2 } from "../core/networks.js";
import type { PaymentPayload, PaymentRequirementsResponse, PaymentRequirement } from "../core/types.js";

export interface WithX402Options {
  /** Recipient address. */
  payTo: string;
  /** Amount in atomic units. */
  amount: string;
  /** Network to accept payment on. */
  network: string;
  /** Token contract address. Defaults to network's default asset. */
  asset?: string;
  /** Human-readable description. */
  description?: string;
  /** Override facilitator URL. */
  facilitatorUrl?: string;
  /** API key for mainnet access. Required for Base, Radius, and Solana mainnet. Get yours at dashboard.stablecoin.xyz */
  apiKey?: string;
  /** Settle on-chain (default: true). */
  settle?: boolean;
  /** Custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/** Next.js App Router handler type */
type NextRouteHandler = (request: Request, context?: unknown) => Promise<Response> | Response;

interface ResolvedEntry {
  opt: WithX402Options & { settle: boolean };
  asset: string;
  facilitator: FacilitatorClient;
}

/**
 * Wrap a Next.js App Router route handler behind x402 payment.
 */
export function withX402(opts: WithX402Options | WithX402Options[], handler: NextRouteHandler): NextRouteHandler {
  const optArray = Array.isArray(opts) ? opts : [opts];

  // Validate all networks upfront and build resolved entries
  const entries: ResolvedEntry[] = optArray.map((opt) => {
    const networkConfig = SUPPORTED_NETWORKS[opt.network];
    if (!networkConfig) {
      throw new Error(`withX402: unsupported network "${opt.network}"`);
    }
    return {
      opt: { ...opt, settle: opt.settle !== false },
      asset: opt.asset ?? networkConfig.defaultAsset,
      facilitator: new FacilitatorClient({ facilitatorUrl: opt.facilitatorUrl, fetchFn: opt.fetchFn, apiKey: opt.apiKey }),
    };
  });

  return async function x402RouteHandler(request: Request, context?: unknown): Promise<Response> {
    const rawHeader =
      request.headers.get("payment-signature") ??
      request.headers.get("x-payment");

    if (!rawHeader) {
      return build402Response(request.url, entries);
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = JSON.parse(fromBase64(rawHeader)) as PaymentPayload;
    } catch {
      return build402Response(request.url, entries, "Invalid payment header");
    }

    // Match payment to requirement by CAIP-2 network
    const paymentNetwork = paymentPayload.accepted?.network;
    const matched = entries.find(({ opt }) => toCAIP2(opt.network) === paymentNetwork);

    if (!matched) {
      return build402Response(
        request.url,
        entries,
        `No payment option found for network "${paymentNetwork}"`
      );
    }

    const { opt, asset, facilitator } = matched;
    const requirement = buildRequirement(request.url, opt.payTo, opt.amount, asset, opt.network, opt.description);

    try {
      // Verify
      const verifyResult = await facilitator.verify(paymentPayload, requirement);
      if (!verifyResult.isValid) {
        return build402Response(request.url, entries, verifyResult.invalidReason);
      }

      // Settle
      const responseHeaders = new Headers();
      if (opt.settle) {
        const settleResult = await facilitator.settle(paymentPayload, requirement);
        if (!settleResult.success) {
          return Response.json(
            { error: `Payment settlement failed: ${settleResult.error ?? settleResult.errorReason}` },
            { status: 402 }
          );
        }

        const txHash = settleResult.txHash ?? settleResult.transaction;
        if (txHash) {
          const paymentResponse = toBase64(
            JSON.stringify({ success: true, transaction: txHash, network: opt.network })
          );
          responseHeaders.set("PAYMENT-RESPONSE", paymentResponse);
        }
      }

      // Call the original handler
      const handlerResponse = await handler(request, context);

      // Merge PAYMENT-RESPONSE header into the handler's response
      if (responseHeaders.has("PAYMENT-RESPONSE")) {
        const newHeaders = new Headers(handlerResponse.headers);
        newHeaders.set("PAYMENT-RESPONSE", responseHeaders.get("PAYMENT-RESPONSE")!);
        return new Response(handlerResponse.body, {
          status: handlerResponse.status,
          statusText: handlerResponse.statusText,
          headers: newHeaders,
        });
      }

      return handlerResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Payment processing failed: ${message}` }, { status: 402 });
    }
  };
}

// ---- Helpers ----

function buildRequirements(resource: string, entries: ResolvedEntry[]): PaymentRequirement[] {
  return entries.map(({ opt, asset }) =>
    buildRequirement(resource, opt.payTo, opt.amount, asset, opt.network, opt.description)
  );
}

function build402Response(
  resource: string,
  entries: ResolvedEntry[],
  errorMessage?: string
): Response {
  const requirements = buildRequirements(resource, entries);
  const body: PaymentRequirementsResponse = {
    x402Version: 2,
    accepts: requirements,
  };

  const paymentRequiredHeader = toBase64(JSON.stringify(body));
  const headers = new Headers({
    "Content-Type": "application/json",
    "PAYMENT-REQUIRED": paymentRequiredHeader,
  });

  return new Response(
    JSON.stringify({ ...body, ...(errorMessage ? { error: errorMessage } : {}) }),
    { status: 402, headers }
  );
}

function buildRequirement(
  resource: string,
  payTo: string,
  amount: string,
  asset: string,
  network: string,
  description?: string
): PaymentRequirement {
  const networkConfig = SUPPORTED_NETWORKS[network];
  return {
    scheme: "exact",
    network,
    maxAmountRequired: amount,
    resource,
    description,
    payTo,
    asset,
    maxTimeoutSeconds: 300,
    facilitator: networkConfig?.facilitatorAddress,
    extra: networkConfig?.tokenName ? { name: networkConfig.tokenName } : undefined,
  };
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
