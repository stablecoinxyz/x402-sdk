/**
 * EVM signing utilities for x402 payment payloads.
 *
 * - Fetches ERC-2612 permit nonce via raw eth_call (no viem PublicClient needed).
 * - Constructs and signs EIP-712 Permit, SBC Payment, and EIP-3009 payloads.
 * - signPermit2Payment builds the x402 v2 Exact EVM Permit2 payload, the only EVM payload
 *   the SBC facilitator settles. signPermit / signTransferAuthorization are the legacy
 *   ERC-2612 / EIP-3009 payloads, kept exported for callers but no longer used by the client.
 */

import type { EvmSigner } from "./signer.js";
import type {
  AuthorizationPayload,
  TransferAuthorization,
  Eip3009Payload,
  PaymentRequirement,
  Permit2Payload,
  Eip2612GasSponsoring,
} from "../core/types.js";
import { getNetworkConfig } from "../core/networks.js";
import { SigningError, NetworkError } from "../core/errors.js";
import { withRetry } from "../core/retry.js";

// ---- EIP-712 type definitions ----

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// ---- Permit2 (x402 v2 Exact EVM) ----
// Copied from x402-facilitator src/evm/permit2.ts, which verifies these signatures.

/** Canonical Uniswap Permit2 deployment. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** x402 Permit2 proxy: the Permit2 spender, which enforces the signed witness recipient. */
export const X402_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";

const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

/** Bounds on the permit window a seller may ask for (same as the SBC agent platform's payer). */
const MIN_PERMIT_SECONDS = 30;
const MAX_PERMIT_SECONDS = 600;

export interface SignPermit2Result {
  payload: Permit2Payload;
  /** Present when the payer's Permit2 allowance is below the amount; see signPermit2Payment. */
  extensions?: { eip2612GasSponsoring: { info: Eip2612GasSponsoring } };
}

/**
 * Sign the x402 v2 Exact EVM Permit2 payment for one `permit2` offer.
 *
 * The payment is a Permit2 `PermitWitnessTransferFrom` to the x402 proxy whose witness binds
 * `payTo`. Permit2 can only move the token if the payer has approved it. When the current
 * allowance (read on chain) is below the amount, an ERC-2612 permit granting Permit2 exactly
 * the amount is added as the `eip2612GasSponsoring` extension, so the payer needs no prior
 * on-chain approval. It is left out when the allowance already covers the amount, because an
 * ERC-2612 permit SETS the allowance: it would overwrite a standing Permit2 approval the
 * payer uses elsewhere.
 *
 * Signatures must be 65-byte EOA signatures; the facilitator rejects longer ERC-1271 ones.
 */
export async function signPermit2Payment(
  signer: EvmSigner,
  params: {
    network: string; // friendly name, e.g. "base-sepolia"
    offer: PaymentRequirement;
    rpcUrlOverride?: string;
    fetchFn?: typeof fetch;
  }
): Promise<SignPermit2Result> {
  const { network, offer, fetchFn } = params;
  const config = getNetworkConfig(network);
  const rpcUrl = params.rpcUrlOverride ?? config.rpcUrl;
  const amount = offer.amount ?? offer.maxAmountRequired;
  if (!/^[1-9]\d*$/.test(amount)) throw new SigningError(`Offer amount must be a positive integer, got "${amount}"`);

  const requested = Number(offer.maxTimeoutSeconds);
  const windowSeconds = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), MIN_PERMIT_SECONDS), MAX_PERMIT_SECONDS)
    : MAX_PERMIT_SECONDS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + windowSeconds);
  const nonce = BigInt(randomHex32()); // Permit2 nonces are unordered: any unused 256-bit value

  const signature = await signer.signTypedData({
    domain: { name: "Permit2", chainId: config.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: offer.asset, amount: BigInt(amount) },
      spender: X402_PERMIT2_PROXY,
      nonce,
      deadline,
      witness: { to: offer.payTo, validAfter: 0n },
    },
  });

  const payload: Permit2Payload = {
    signature,
    permit2Authorization: {
      permitted: { token: offer.asset, amount },
      from: signer.address,
      spender: X402_PERMIT2_PROXY,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      witness: { to: offer.payTo, validAfter: "0" },
    },
  };

  if (!rpcUrl) {
    throw new NetworkError(network, `No RPC URL configured for network "${network}". Pass rpcUrl.`);
  }
  const allowance = await readUint256(rpcUrl, offer.asset, `0xdd62ed3e${pad32(signer.address)}${pad32(PERMIT2_ADDRESS)}`, "Get Permit2 allowance", fetchFn);
  if (allowance >= BigInt(amount)) return { payload };

  const tokenName = offer.extra?.name;
  const tokenVersion = offer.extra?.version;
  if (!tokenName || !tokenVersion) {
    throw new SigningError("Offer has no EIP-712 name/version, so Permit2 cannot be approved by signature; approve Permit2 on chain first");
  }
  const tokenNonce = await getPermitNonce(rpcUrl, offer.asset, signer.address, fetchFn);
  const sponsorSignature = await signer.signTypedData({
    domain: { name: tokenName, version: tokenVersion, chainId: config.chainId, verifyingContract: offer.asset },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner: signer.address, spender: PERMIT2_ADDRESS, value: BigInt(amount), nonce: tokenNonce, deadline },
  });

  return {
    payload,
    extensions: {
      eip2612GasSponsoring: {
        info: {
          from: signer.address,
          asset: offer.asset,
          spender: PERMIT2_ADDRESS,
          amount,
          nonce: tokenNonce.toString(),
          deadline: deadline.toString(),
          signature: sponsorSignature,
          version: "1", // the extension's version, not the token's
        },
      },
    },
  };
}

// ---- Raw RPC helpers ----

function pad32(address: string): string {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

/** eth_call returning one uint256. */
async function readUint256(
  rpcUrl: string,
  to: string,
  data: string,
  operation: string,
  fetchFn: typeof fetch = globalThis.fetch as typeof fetch
): Promise<bigint> {
  return withRetry(
    async () => {
      const response = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      if (!response.ok) throw new Error(`RPC request failed: ${response.status}`);
      const json = (await response.json()) as { result?: string; error?: { message: string } };
      if (json.error) throw new SigningError(`${operation} failed: ${json.error.message}`);
      const result = json.result ?? "0x0";
      return BigInt(result === "0x" ? "0x0" : result);
    },
    operation,
    { maxAttempts: 3 }
  );
}

/**
 * Fetch ERC-2612 permit nonce via raw eth_call.
 * ABI-encodes: nonces(address owner) → uint256
 */
export async function getPermitNonce(
  rpcUrl: string,
  tokenAddress: string,
  ownerAddress: string,
  fetchFn: typeof fetch = globalThis.fetch as typeof fetch
): Promise<bigint> {
  return withRetry(
    async () => {
      // ABI encode: nonces(address) selector = keccak256("nonces(address)")[0:4] = 0x7ecebe00
      // Pad the 20-byte address to 32 bytes
      const paddedOwner = ownerAddress.toLowerCase().replace("0x", "").padStart(64, "0");
      const callData = `0x7ecebe00${paddedOwner}`;

      const response = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: callData }, "latest"],
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const json = (await response.json()) as { result?: string; error?: { message: string } };

      if (json.error) {
        throw new SigningError(`Failed to fetch permit nonce: ${json.error.message}`);
      }

      const result = json.result ?? "0x0";
      return BigInt(result === "0x" ? "0x0" : result);
    },
    "Get permit nonce",
    { maxAttempts: 3 }
  );
}

/**
 * Fetch ERC-20 token balance via raw eth_call.
 * ABI-encodes: balanceOf(address owner) → uint256
 */
export async function getTokenBalance(
  rpcUrl: string,
  tokenAddress: string,
  ownerAddress: string,
  fetchFn: typeof fetch = globalThis.fetch as typeof fetch
): Promise<bigint> {
  return withRetry(
    async () => {
      // balanceOf(address) selector = 0x70a08231
      const paddedOwner = ownerAddress.toLowerCase().replace("0x", "").padStart(64, "0");
      const callData = `0x70a08231${paddedOwner}`;

      const response = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: callData }, "latest"],
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const json = (await response.json()) as { result?: string; error?: { message: string } };

      if (json.error) {
        throw new Error(`Failed to fetch token balance: ${json.error.message}`);
      }

      const result = json.result ?? "0x0";
      return BigInt(result === "0x" ? "0x0" : result);
    },
    "Get token balance",
    { maxAttempts: 3 }
  );
}

// ---- Signing functions ----

export interface SignPermitResult {
  payload: AuthorizationPayload;
}

/**
 * Sign an ERC-2612 Permit (V2 x402 flow).
 * Returns an AuthorizationPayload matching the facilitator's expected format.
 * Fetches the nonce via raw RPC so no viem PublicClient is needed.
 */
export async function signPermit(
  signer: EvmSigner,
  params: {
    network: string;
    spender: string; // facilitator address
    value: string; // atomic units
    tokenAddress: string;
    tokenName: string;
    validForSeconds?: number;
    rpcUrlOverride?: string;
    fetchFn?: typeof fetch;
  }
): Promise<SignPermitResult> {
  const {
    network,
    spender,
    value,
    tokenAddress,
    tokenName,
    validForSeconds = 300,
    fetchFn,
  } = params;

  const config = getNetworkConfig(network);
  const rpcUrl = params.rpcUrlOverride ?? config.rpcUrl;

  if (!rpcUrl) {
    throw new NetworkError(network, `No RPC URL configured for network "${network}". Pass rpcUrlOverride.`);
  }

  const nonce = await getPermitNonce(rpcUrl, tokenAddress, signer.address, fetchFn);

  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + validForSeconds;

  const domain = {
    name: tokenName,
    version: "1",
    chainId: config.chainId,
    verifyingContract: tokenAddress,
  };

  const message = {
    owner: signer.address,
    spender,
    value: BigInt(value),
    nonce,
    deadline: BigInt(validBefore),
  };

  const signature = await signer.signTypedData({
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message,
  });

  return {
    payload: {
      authorization: {
        from: signer.address,
        to: spender,
        value,
        validAfter: "0",
        validBefore,
        nonce: nonce.toString(),
      },
      signature,
    },
  };
}

export interface SignTransferAuthorizationResult {
  authorization: TransferAuthorization;
  payload: Eip3009Payload;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization (for USDC and similar).
 */
export async function signTransferAuthorization(
  signer: EvmSigner,
  params: {
    network: string;
    to: string;
    value: string;
    assetAddress: string;
    tokenName: string;
    tokenVersion?: string;
    validForSeconds?: number;
  }
): Promise<SignTransferAuthorizationResult> {
  const { network, to, value, assetAddress, tokenName, tokenVersion = "2", validForSeconds = 300 } = params;
  const config = getNetworkConfig(network);

  const now = Math.floor(Date.now() / 1000);
  const authorization: TransferAuthorization = {
    from: signer.address,
    to,
    value,
    validAfter: now - 60,
    validBefore: now + validForSeconds,
    nonce: randomHex32(),
  };

  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId: config.chainId,
    verifyingContract: assetAddress,
  };

  const signature = await signer.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization as unknown as Record<string, unknown>,
  });

  return {
    authorization,
    payload: { signature, authorization },
  };
}

// ---- Helpers ----

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
