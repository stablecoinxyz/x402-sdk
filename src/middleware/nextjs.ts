/**
 * paywall — Next.js App Router wrapper for x402 payment-gated route handlers.
 *
 * Usage:
 *   import { paywall } from '@stablecoin.xyz/x402/middleware/nextjs'
 *   export const GET = paywall({ payTo: '0x...', amount: '1000', network: 'base-sepolia' }, handler)
 *
 * Multi-network:
 *   export const GET = paywall([
 *     { payTo: '0x...', amount: '1000000000000000', network: 'base' },
 *     { payTo: '2mSj...', amount: '1000000', network: 'solana' },
 *   ], handler)
 */

import { FacilitatorClient } from "../core/facilitator.js";
import {
  buildRequirement,
  matchRequirement,
  resolvePayer,
  resolveRequirement,
  settleErrorReply,
  unsettledReply,
  suiVerifyRejectReply,
  type ResolvedRequirement,
} from "../core/requirements.js";
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
  /** EIP-712 domain name of `asset`. Only needed for an EVM token this SDK does not list. */
  tokenName?: string;
  /** EIP-712 domain version of `asset`. Only needed for an EVM token this SDK does not list. */
  tokenVersion?: string;
  /** Human-readable description. */
  description?: string;
  /** Override facilitator URL. */
  facilitatorUrl?: string;
  /** Settle on-chain (default: true). */
  settle?: boolean;
  /** Custom fetch (for testing). */
  fetchFn?: typeof fetch;
}

/** Next.js App Router handler type */
type NextRouteHandler = (request: Request, context?: unknown) => Promise<Response> | Response;

interface ResolvedEntry {
  opt: WithX402Options & { settle: boolean };
  resolved: ResolvedRequirement;
  facilitator: FacilitatorClient;
}

/**
 * Wrap a Next.js App Router route handler behind x402 payment.
 */
export function paywall(opts: WithX402Options | WithX402Options[], handler: NextRouteHandler): NextRouteHandler {
  const optArray = Array.isArray(opts) ? opts : [opts];

  // Validate all networks upfront and build resolved entries
  const entries: ResolvedEntry[] = optArray.map((opt) => {
    return {
      opt: { ...opt, settle: opt.settle !== false },
      resolved: resolveRequirement(opt, "withX402"),
      facilitator: new FacilitatorClient({ facilitatorUrl: opt.facilitatorUrl, fetchFn: opt.fetchFn }),
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
    const matched = matchRequirement(entries, paymentPayload.accepted);

    if (!matched) {
      return build402Response(
        request.url,
        entries,
        `No payment option on network "${paymentNetwork}" matches the offer in the payment`
      );
    }

    const { opt, resolved, facilitator } = matched;
    const requirement = buildRequirement(request.url, resolved);

    let enrichedRequest: Request;
    const responseHeaders = new Headers();
    try {
      // Verify
      const verifyResult = await facilitator.verify(paymentPayload, requirement);
      if (!verifyResult.isValid) {
        const rejected = suiVerifyRejectReply(opt.network, verifyResult);
        if (rejected) return Response.json(rejected.body, { status: rejected.status });
        return build402Response(request.url, entries, verifyResult.invalidReason);
      }

      // Settle
      if (opt.settle) {
        let settleResult;
        try {
          settleResult = await facilitator.settle(paymentPayload, requirement);
        } catch (err) {
          const reply = settleErrorReply(err instanceof Error ? err.message : String(err));
          return Response.json(reply.body, { status: reply.status });
        }
        if (!settleResult.success) {
          const unsettled = unsettledReply(settleResult);
          if (unsettled) return Response.json(unsettled.body, { status: unsettled.status });
          // Terminal (e.g. mined and reverted): no money moved. Any hash is evidence of that.
          const tx = settleResult.txHash ?? settleResult.transaction;
          return Response.json(
            {
              error: `Payment settlement failed: ${settleResult.error ?? settleResult.errorReason}`,
              ...(settleResult.errorReason ? { errorReason: settleResult.errorReason } : {}),
              ...(tx ? { transaction: tx } : {}),
            },
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

      // Attach payment metadata as headers so the handler can read them. Incoming
      // x-payment-* headers are the buyer's and are dropped first, so none can be forged.
      const payer = resolvePayer(verifyResult.payer, paymentPayload.payload);
      const enrichedHeaders = new Headers(request.headers);
      const forged: string[] = [];
      enrichedHeaders.forEach((_value, name) => {
        if (name.toLowerCase().startsWith("x-payment-")) forged.push(name);
      });
      for (const name of forged) enrichedHeaders.delete(name);
      enrichedHeaders.set("x-payment-payer", payer);
      enrichedHeaders.set("x-payment-network", opt.network);
      enrichedHeaders.set("x-payment-amount", opt.amount);

      const prValue = responseHeaders.get("PAYMENT-RESPONSE");
      if (prValue) {
        try {
          const decoded = JSON.parse(fromBase64(prValue));
          if (decoded.transaction) enrichedHeaders.set("x-payment-tx", decoded.transaction);
        } catch {}
      }

      enrichedRequest = new Request(request.url, {
        method: request.method,
        headers: enrichedHeaders,
        body: request.body,
        // @ts-expect-error duplex needed for streaming bodies
        duplex: "half",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Payment processing failed: ${message}` }, { status: 402 });
    }

    // The handler runs outside the payment try: once settled, a handler error is the
    // handler's own error (a 500 from Next.js), never a 402 that invites a second payment.
    const handlerResponse = await handler(enrichedRequest, context);

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
  };
}

// ---- Helpers ----

function buildRequirements(resource: string, entries: ResolvedEntry[]): PaymentRequirement[] {
  return entries.map(({ resolved }) => buildRequirement(resource, resolved));
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

/** @deprecated Use `paywall` instead. */
export const withX402 = paywall;
