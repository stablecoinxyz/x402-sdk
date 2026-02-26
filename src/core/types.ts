/**
 * x402 Protocol Types
 */

export interface PaymentRequirement {
  scheme: "exact" | "upto";
  network: string;
  maxAmountRequired: string; // atomic units (e.g., "1000000" for 1 USDC)
  resource: string; // URL of the resource
  description?: string;
  mimeType?: string;
  payTo: string; // recipient address
  asset: string; // token contract address
  maxTimeoutSeconds: number;
  facilitator?: string; // facilitator address for EIP-712 domain
  extra?: {
    name?: string; // token name for EIP-712
    version?: string; // token version for EIP-712
  };
}

export interface PaymentRequirementsResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
}

export interface SbcPaymentPayload {
  signature: string;
  from: string;
  to: string;
  amount: string;
  nonce: number;
  deadline: number;
}

export interface Eip3009Payload {
  signature: string;
  authorization: TransferAuthorization;
}

/**
 * ERC-2612 Permit payload — matches facilitator's expected inner structure.
 * `authorization.to` is the facilitator address (spender).
 * `authorization.validBefore` is the permit deadline (Unix timestamp).
 * Facilitator splits v/r/s from the 65-byte `signature` itself.
 */
export interface AuthorizationPayload {
  authorization: {
    from: string;     // payer (owner)
    to: string;       // facilitator (spender)
    value: string;    // atomic units
    validBefore: number; // permit deadline, Unix timestamp
    nonce: string;    // ERC-2612 nonce, stringified bigint
  };
  signature: string;  // full 65-byte hex sig — facilitator splits v/r/s
}

export interface SolanaPaymentPayload {
  from: string; // Base58 public key
  to: string; // Base58 public key
  amount: string; // amount in base units
  nonce: string; // timestamp or unique identifier
  deadline: number; // Unix timestamp
  signature: string; // Base58 Ed25519 signature
}

export type PaymentPayloadInner =
  | SbcPaymentPayload
  | Eip3009Payload
  | AuthorizationPayload
  | SolanaPaymentPayload;

/**
 * Outer payment payload sent to the facilitator and in the PAYMENT-SIGNATURE header.
 * `accepted.network` uses CAIP-2 format: "eip155:8453", "solana:mainnet-beta", etc.
 */
export interface PaymentPayload {
  accepted: {
    network: string; // CAIP-2
    scheme: string;  // "exact"
  };
  payload: PaymentPayloadInner;
}

export interface VerifyRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirement;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
}

export interface SettleRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirement;
}

export interface SettleResponse {
  success: boolean;
  txHash?: string;
  transaction?: string;
  networkId?: string;
  network?: string;
  error?: string;
  errorReason?: string;
}

export interface PaymentResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

export interface PaymentResult {
  success: boolean;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  txHash?: string;
  amountPaid?: string;
  network?: string;
  error?: string;
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  facilitatorUrl: string;
  facilitatorAddress: string;
  defaultAsset: string;
  explorerUrl?: string;
  decimals: number;
  tokenName: string; // EIP-712 domain name (must match token's on-chain name())
}
