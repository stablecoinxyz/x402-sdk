/**
 * x402 Protocol Types
 */

export interface PaymentRequirement {
  scheme: "exact" | "upto";
  network: string; // CAIP-2 for EVM ("eip155:8453"); friendly name for Solana
  /** x402 v2 amount, atomic units. Present on EVM requirements. */
  amount?: string;
  /** Same value as `amount`; kept for readers of the older field. */
  maxAmountRequired: string; // atomic units (e.g., "1000000" for 1 USDC)
  resource: string; // URL of the resource
  description?: string;
  mimeType?: string;
  payTo: string; // recipient address
  asset: string; // token contract address
  maxTimeoutSeconds: number;
  facilitator?: string; // ERC-2612 spender; Solana only now (EVM settles through Permit2)
  extra?: {
    assetTransferMethod?: "permit2";
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
    validAfter: string; // earliest valid time ("0" for immediate)
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

/** Sui `exact` payload: a signed, gasless USDC transfer the facilitator submits. */
export interface SuiPaymentPayload {
  transaction: string; // base64 BCS transaction bytes
  signature: string;   // base64 Sui signature over them
}

/** x402 v2 Exact EVM Permit2 payload: a PermitWitnessTransferFrom to the x402 proxy. */
export interface Permit2Payload {
  signature: string; // 65-byte EOA signature
  permit2Authorization: {
    permitted: { token: string; amount: string };
    from: string;
    spender: string; // x402 Permit2 proxy
    nonce: string; // decimal
    deadline: string; // decimal Unix seconds
    witness: { to: string; validAfter: string };
  };
}

/** ERC-2612 permit granting Permit2 the payment amount, sent as an x402 extension. */
export interface Eip2612GasSponsoring {
  from: string;
  asset: string;
  spender: string; // Permit2
  amount: string;
  nonce: string;
  deadline: string;
  signature: string;
  version: string; // extension version, "1"
}

export type PaymentPayloadInner =
  | Permit2Payload
  | Eip3009Payload
  | AuthorizationPayload
  | SolanaPaymentPayload
  | SuiPaymentPayload;

/**
 * Outer payment payload sent to the facilitator and in the PAYMENT-SIGNATURE header.
 * `accepted.network` uses CAIP-2 format: "eip155:8453", "solana:mainnet-beta", etc.
 */
export interface PaymentPayload {
  x402Version?: number;
  /** URL the payment is for. */
  resource?: string;
  /** x402 extensions, e.g. `eip2612GasSponsoring` on EVM. */
  extensions?: Record<string, unknown>;
  accepted: {
    network: string; // CAIP-2
    scheme: string;  // "exact"
    /** Echoed from the offer by v2 buyers; used to tell same-network offers apart. */
    amount?: string;
    asset?: string;
    payTo?: string;
    extra?: PaymentRequirement["extra"];
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
  /** Payer address as the facilitator recovered it. */
  payer?: string;
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
  /** The seller answered 202: the payment was broadcast and its outcome is not yet known. */
  pending?: boolean;
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
  /**
   * EVM tokens the paywall can price in without the seller naming the EIP-712 domain.
   * Permit2 requirements carry each token's `name` and `version`, and the facilitator
   * requires the buyer's echoed offer to match them exactly.
   */
  tokens?: EvmTokenInfo[];
}

export interface EvmTokenInfo {
  address: string;
  /** EIP-712 domain name: the token's on-chain `name()`. */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  /**
   * The token's on-chain `decimals()`. The client's `maxAmount` cap converts USD to atomic
   * units with this, never with the network-wide `decimals` (a network can carry tokens of
   * different decimals: SBC 18 and USDC 6 on Base).
   */
  decimals: number;
}
