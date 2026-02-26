/**
 * Custom error classes for x402 SDK
 */

export class InsufficientBalanceError extends Error {
  public readonly balance: string;
  public readonly required: string;

  constructor(balance: string, required: string) {
    super(`Insufficient balance. Required: ${required}, Available: ${balance}`);
    this.name = "InsufficientBalanceError";
    this.balance = balance;
    this.required = required;
  }
}

export class FacilitatorError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "FacilitatorError";
    this.statusCode = statusCode;
  }
}

export class PaymentTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out`);
    this.name = "PaymentTimeoutError";
  }
}

export class NetworkError extends Error {
  public readonly network: string;

  constructor(network: string, message: string) {
    super(message);
    this.name = "NetworkError";
    this.network = network;
  }
}

export class PaymentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}
