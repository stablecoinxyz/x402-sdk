/**
 * Solana signing utilities for x402 payment payloads.
 *
 * Message format must match exactly what the facilitator's verify.ts expects:
 * "from:{from}|to:{to}|amount:{amount}|nonce:{nonce}|deadline:{deadline}"
 */

import bs58 from "bs58";
import type { SolanaSigner } from "./signer.js";
import type { SolanaPaymentPayload } from "../core/types.js";

export interface SignSolanaPaymentResult {
  payload: SolanaPaymentPayload;
}

/**
 * Sign a Solana x402 payment message.
 *
 * The nonce is a timestamp string (unique per payment).
 * The message format is: from:{from}|to:{to}|amount:{amount}|nonce:{nonce}|deadline:{deadline}
 * This must match the facilitator's constructMessage() exactly.
 */
export async function signSolanaPayment(
  signer: SolanaSigner,
  params: {
    to: string; // Base58 recipient public key
    amount: string; // Amount in base units (lamports / token decimals)
    validForSeconds?: number;
  }
): Promise<SignSolanaPaymentResult> {
  const { to, amount, validForSeconds = 300 } = params;

  const now = Math.floor(Date.now() / 1000);
  const nonce = now.toString();
  const deadline = now + validForSeconds;

  const message = constructMessage({
    from: signer.publicKey,
    to,
    amount,
    nonce,
    deadline,
  });

  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = await signer.sign(messageBytes);
  const signature = bs58.encode(signatureBytes);

  return {
    payload: {
      from: signer.publicKey,
      to,
      amount,
      nonce,
      deadline,
      signature,
    },
  };
}

/**
 * Construct the canonical x402 Solana payment message.
 * Must match facilitator's constructMessage() verbatim.
 */
export function constructMessage(data: {
  from: string;
  to: string;
  amount: string;
  nonce: string;
  deadline: number;
}): string {
  return `from:${data.from}|to:${data.to}|amount:${data.amount}|nonce:${data.nonce}|deadline:${data.deadline}`;
}

/**
 * Verify a Solana payment signature locally (for testing / server-side use).
 */
export async function verifySolanaSignature(payload: SolanaPaymentPayload): Promise<boolean> {
  try {
    const { default: nacl } = await import("tweetnacl");
    const message = constructMessage(payload);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(payload.signature);
    const publicKeyBytes = bs58.decode(payload.from);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
