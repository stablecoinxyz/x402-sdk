/**
 * USD-cap arithmetic shared by the EVM and Solana clients.
 */

import { SUPPORTED_NETWORKS } from "./networks.js";

/** A plain non-negative decimal: digits, optionally a dot and more digits. Nothing else. */
const USD_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * Convert a USD amount ("0.05") to atomic units of a token with `decimals` decimals.
 *
 * Throws on anything that is not a plain non-negative decimal ("0x10", "1.5.5", "-1", "1e6",
 * " 1"): `maxAmount` is a spending cap, and a cap the caller mistyped must fail loudly, not be
 * read as some other number. Fractional digits beyond `decimals` are dropped, which can only
 * lower the cap.
 */
export function usdToAtomic(usdAmount: string, decimals: number): bigint {
  if (typeof usdAmount !== "string" || !USD_AMOUNT.test(usdAmount)) {
    throw new Error(`x402: maxAmount must be a non-negative decimal string like "0.05", got ${JSON.stringify(usdAmount)}`);
  }
  const [whole, fraction = ""] = usdAmount.split(".");
  const fractional = fraction.length > decimals ? fraction.slice(0, decimals) : fraction.padEnd(decimals, "0");
  return BigInt(whole + fractional);
}

/**
 * Decimals of an EVM token this SDK knows on `network` (friendly name), or `undefined`.
 *
 * Only the registry in networks.ts is trusted: the asset address comes from the seller, so its
 * own `decimals()` (or a token the registry does not list, whose USD value is unknown) cannot
 * be used to enforce a USD cap.
 */
export function knownTokenDecimals(network: string, asset: string): number | undefined {
  const tokens = SUPPORTED_NETWORKS[network]?.tokens;
  return tokens?.find((t) => t.address.toLowerCase() === asset.toLowerCase())?.decimals;
}
