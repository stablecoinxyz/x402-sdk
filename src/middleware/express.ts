/**
 * x402Middleware for Express
 *
 * Gates an Express route behind x402 payment.
 * No signing — server-side only validates incoming payment headers.
 *
 * Usage (single network):
 *   app.use('/premium', x402Middleware({ payTo: '0x...', amount: '1000000', network: 'base' }))
 *
 * Usage (multi-network):
 *   app.use('/premium', x402Middleware([
 *     { payTo: '0x...', amount: '1000000000000000', network: 'base' },
 *     { payTo: '2mSj...', amount: '1000000', network: 'solana' },
 *   ]))
 */

import { FacilitatorClient } from "../core/facilitator.js";
import { SUPPORTED_NETWORKS, toCAIP2 } from "../core/networks.js";
import type {
  PaymentPayload,
  PaymentRequirementsResponse,
  PaymentRequirement,
} from "../core/types.js";

export interface X402MiddlewareOptions {
  /** Recipient address (server wallet or multisig). */
  payTo: string;
  /** Amount in atomic units (e.g. "1000000" = 1 USDC at 6 decimals, or "1000000000000000000" = 1 SBC at 18 decimals). */
  amount: string;
  /** Network to accept payment on. */
  network: string;
  /** Token contract address. Defaults to network's default asset. */
  asset?: string;
  /** Human-readable description shown to payer. */
  description?: string;
  /** Override facilitator URL. Defaults to network config. */
  facilitatorUrl?: string;
  /** Settle payment on-chain (default: true). Set false to only verify. */
  settle?: boolean;
  /** Custom fetch implementation (for testing). */
  fetchFn?: typeof fetch;
}

// Minimal Express types to avoid a hard peer-dep import at module level
type ExpressRequest = {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
};
type ExpressResponse = {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
};
type NextFunction = (err?: unknown) => void;

interface ResolvedEntry {
  opt: X402MiddlewareOptions & { settle: boolean };
  asset: string;
  facilitator: FacilitatorClient;
}

export function x402Middleware(opts: X402MiddlewareOptions | X402MiddlewareOptions[]) {
  const optArray = Array.isArray(opts) ? opts : [opts];

  // Validate all networks upfront and build resolved entries
  const entries: ResolvedEntry[] = optArray.map((opt) => {
    const networkConfig = SUPPORTED_NETWORKS[opt.network];
    if (!networkConfig) {
      throw new Error(`x402Middleware: unsupported network "${opt.network}"`);
    }
    return {
      opt: { ...opt, settle: opt.settle !== false },
      asset: opt.asset ?? networkConfig.defaultAsset,
      facilitator: new FacilitatorClient({ facilitatorUrl: opt.facilitatorUrl, fetchFn: opt.fetchFn }),
    };
  });

  return async function x402Handler(req: ExpressRequest, res: ExpressResponse, next: NextFunction) {
    const rawHeader =
      (req.headers["payment-signature"] as string) ??
      (req.headers["x-payment"] as string);

    if (!rawHeader) {
      return send402(res, buildRequirements(req.url, entries));
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = JSON.parse(fromBase64(rawHeader)) as PaymentPayload;
    } catch {
      return send402(res, buildRequirements(req.url, entries), "Invalid payment header");
    }

    // Match payment to requirement by CAIP-2 network
    const paymentNetwork = paymentPayload.accepted?.network;
    const matched = entries.find(({ opt }) => toCAIP2(opt.network) === paymentNetwork);

    if (!matched) {
      return send402(
        res,
        buildRequirements(req.url, entries),
        `No payment option found for network "${paymentNetwork}"`
      );
    }

    const { opt, asset, facilitator } = matched;
    const requirement = buildRequirement(req.url, opt.payTo, opt.amount, asset, opt.network, opt.description);

    try {
      // Verify
      const verifyResult = await facilitator.verify(paymentPayload, requirement);
      console.log("[x402] verify →", JSON.stringify(verifyResult));
      if (!verifyResult.isValid) {
        return send402(res, buildRequirements(req.url, entries), verifyResult.invalidReason);
      }

      // Settle
      if (opt.settle) {
        const settleResult = await facilitator.settle(paymentPayload, requirement);
        console.log("[x402] settle →", JSON.stringify(settleResult));
        if (!settleResult.success) {
          return res.status(402).json({
            error: `Payment settlement failed: ${settleResult.error ?? settleResult.errorReason}`,
          });
        }

        const txHash = settleResult.txHash ?? settleResult.transaction;
        if (txHash) {
          const paymentResponse = toBase64(
            JSON.stringify({ success: true, transaction: txHash, network: opt.network })
          );
          res.setHeader("PAYMENT-RESPONSE", paymentResponse);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[x402] payment processing error:", message);
      return res.status(402).json({ error: `Payment processing failed: ${message}` });
    }

    next();
  };
}

// ---- Helpers ----

function buildRequirements(resource: string, entries: ResolvedEntry[]): PaymentRequirement[] {
  return entries.map(({ opt, asset }) =>
    buildRequirement(resource, opt.payTo, opt.amount, asset, opt.network, opt.description)
  );
}

function send402(
  res: ExpressResponse,
  requirements: PaymentRequirement[],
  errorMessage?: string
) {
  const body: PaymentRequirementsResponse = {
    x402Version: 2,
    accepts: requirements,
  };
  const paymentRequiredHeader = toBase64(JSON.stringify(body));
  res.setHeader("PAYMENT-REQUIRED", paymentRequiredHeader);
  return res.status(402).json({
    ...body,
    ...(errorMessage ? { error: errorMessage } : {}),
  });
}

function buildRequirement(
  resource: string,
  payTo: string,
  amount: string,
  asset: string,
  network: string,
  description?: string,
  maxTimeoutSeconds = 300
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
    maxTimeoutSeconds,
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
