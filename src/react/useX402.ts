/**
 * useX402 — React hook for x402 payments.
 *
 * Usage:
 *   import { useX402, viemSignerAdapter } from '@stablecoin.xyz/x402/react'
 *   const { fetch, paying, lastPayment } = useX402({ signer: viemSignerAdapter(wc), network: 'base' })
 *   const data = await fetch('https://api.example.com/premium').then(r => r.json())
 *
 * AppKit composition:
 *   const { walletClient } = useSbcApp()
 *   const { fetch } = useX402({ signer: walletClient ? viemSignerAdapter(walletClient) : null, network: 'base' })
 */

import { useState, useCallback, useRef } from "react";
import { createX402Client } from "../evm/client.js";
import { viemSignerAdapter, ethersSignerAdapter } from "../evm/signer.js";
import type { EvmSigner } from "../evm/signer.js";
import type { X402ClientOptions } from "../evm/client.js";
import type { PaymentResult } from "../core/types.js";

export type { EvmSigner };
export { viemSignerAdapter, ethersSignerAdapter };

export interface UseX402Options {
  /** Signer. Pass null when wallet is not yet connected — hook will throw if fetch() is called. */
  signer: EvmSigner | null;
  /** Network for payments (e.g. 'base', 'base-sepolia'). */
  network?: string;
  /** Override facilitator URL. */
  facilitatorUrl?: string;
  /** Override RPC URL for raw eth_call (permit nonce, balance). */
  rpcUrl?: string;
  /** Skip balance check (saves an RPC call). Default: false. */
  skipBalanceCheck?: boolean;
  /** API key for mainnet access. Required for Base, Radius, and Solana mainnet. Get yours at dashboard.stablecoin.xyz */
  apiKey?: string;
}

export interface UseX402Return {
  /**
   * Drop-in replacement for window.fetch that handles x402 payments automatically.
   * `paying` is true for the duration of any fetch that triggers a payment.
   */
  fetch(
    url: string,
    options?: RequestInit & {
      /** Preferred network (overrides hook-level `network` option). */
      preferredNetwork?: string;
      /** Max amount willing to pay in USD (e.g. "0.05"). */
      maxAmount?: string;
    }
  ): Promise<Response & { paymentResult?: PaymentResult }>;
  /** True while a payment-bearing fetch is in flight. */
  paying: boolean;
  /** Details of the last completed payment, or null. */
  lastPayment: PaymentResult | null;
  /** Error thrown by the last fetch attempt, or null. */
  error: Error | null;
}

export function useX402(options: UseX402Options): UseX402Return {
  const [paying, setPaying] = useState(false);
  const [lastPayment, setLastPayment] = useState<PaymentResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Stable ref so the memoised callback always reads fresh options
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const x402Fetch = useCallback(
    async (
      url: string,
      fetchOptions?: RequestInit & { preferredNetwork?: string; maxAmount?: string }
    ): Promise<Response & { paymentResult?: PaymentResult }> => {
      const { signer, network, facilitatorUrl, rpcUrl, skipBalanceCheck, apiKey } = optionsRef.current;

      if (!signer) {
        throw new Error("useX402: no signer connected — connect a wallet first.");
      }

      setError(null);

      // Inject a custom fetchFn to detect the 402 and flip paying=true
      let paymentTriggered = false;
      const trackedFetchFn: typeof globalThis.fetch = async (input, init) => {
        const response = await globalThis.fetch(input as RequestInfo, init);
        if (response.status === 402 && !paymentTriggered) {
          paymentTriggered = true;
          setPaying(true);
        }
        return response;
      };

      const clientOptions: X402ClientOptions = {
        signer,
        network,
        facilitatorUrl,
        rpcUrl,
        skipBalanceCheck,
        apiKey,
        fetchFn: trackedFetchFn as unknown as typeof fetch,
      };

      const client = createX402Client(clientOptions);

      try {
        const response = await client.fetch(url, fetchOptions);

        if (response.paymentResult) {
          setLastPayment(response.paymentResult);
        }

        return response;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        if (paymentTriggered) {
          setPaying(false);
        }
      }
    },
    [] // stable — reads options via ref
  );

  return { fetch: x402Fetch, paying, lastPayment, error };
}
