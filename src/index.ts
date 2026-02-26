/**
 * @stablecoin.xyz/x402 — root entry point
 *
 * Convenience re-exports of core types and network config.
 * For signing/paying, import from the subpath entries:
 *   @stablecoin.xyz/x402/evm
 *   @stablecoin.xyz/x402/solana
 *   @stablecoin.xyz/x402/middleware
 *   @stablecoin.xyz/x402/react
 */

export { SUPPORTED_NETWORKS, getNetworkConfig } from "./core/networks.js";
export { FacilitatorClient } from "./core/facilitator.js";
export {
  InsufficientBalanceError,
  FacilitatorError,
  PaymentTimeoutError,
  NetworkError,
  PaymentRequiredError,
  SigningError,
} from "./core/errors.js";
export { withRetry } from "./core/retry.js";
export type {
  NetworkConfig,
  PaymentRequirement,
  PaymentRequirementsResponse,
  PaymentPayload,
  PaymentResult,
  VerifyResponse,
  SettleResponse,
  AuthorizationPayload,
  SbcPaymentPayload,
  SolanaPaymentPayload,
  Eip3009Payload,
  TransferAuthorization,
} from "./core/types.js";
export type { FacilitatorClientOptions } from "./core/facilitator.js";
export type { RetryOptions } from "./core/retry.js";
