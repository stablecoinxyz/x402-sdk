/**
 * EVM signing utilities for x402 payment payloads.
 *
 * - Fetches ERC-2612 permit nonce via raw eth_call (no viem PublicClient needed).
 * - Constructs and signs EIP-712 Permit, SBC Payment, and EIP-3009 payloads.
 */

import type { EvmSigner } from "./signer.js";
import type {
  AuthorizationPayload,
  SbcPaymentPayload,
  TransferAuthorization,
  Eip3009Payload,
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

const SBC_PAYMENT_TYPES = {
  Payment: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
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

// ---- Raw RPC helpers ----

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
        validBefore,
        nonce: nonce.toString(),
      },
      signature,
    },
  };
}

export interface SignSbcPaymentResult {
  payload: SbcPaymentPayload;
}

/**
 * Sign an SBC Payment message (V1 x402 flow).
 */
export async function signSbcPayment(
  signer: EvmSigner,
  params: {
    network: string;
    to: string;
    amount: string;
    facilitatorAddress: string;
    validForSeconds?: number;
  }
): Promise<SignSbcPaymentResult> {
  const { network, to, amount, facilitatorAddress, validForSeconds = 300 } = params;
  const config = getNetworkConfig(network);

  const now = Math.floor(Date.now() / 1000);
  const payment = {
    from: signer.address,
    to,
    amount,
    nonce: now,
    deadline: now + validForSeconds,
  };

  const domain = {
    name: "SBC x402 Facilitator",
    version: "1",
    chainId: config.chainId,
    verifyingContract: facilitatorAddress,
  };

  const message = {
    from: payment.from,
    to: payment.to,
    amount: BigInt(payment.amount),
    nonce: BigInt(payment.nonce),
    deadline: BigInt(payment.deadline),
  };

  const signature = await signer.signTypedData({
    domain,
    types: SBC_PAYMENT_TYPES,
    primaryType: "Payment",
    message,
  });

  return {
    payload: {
      signature,
      from: payment.from,
      to: payment.to,
      amount: payment.amount,
      nonce: payment.nonce,
      deadline: payment.deadline,
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
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}` as string;
  }
  // Node.js fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("crypto") as { randomBytes: (n: number) => Buffer };
  return `0x${randomBytes(32).toString("hex")}` as string;
}
