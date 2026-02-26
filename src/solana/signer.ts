/**
 * SolanaSigner — generic interface for Ed25519 message signing.
 * Adapters for @solana/web3.js Keypair and wallet-adapter wallets.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Generic Solana signer interface.
 * Signs arbitrary byte messages with Ed25519.
 */
export interface SolanaSigner {
  publicKey: string; // Base58 public key
  sign(message: Uint8Array): Promise<Uint8Array>; // returns Ed25519 signature bytes
}

// ---- Keypair adapter (@solana/web3.js) ----

/** Minimal Keypair interface from @solana/web3.js */
interface SolanaKeypair {
  publicKey: {
    toBase58(): string;
    toBytes(): Uint8Array;
  };
  secretKey: Uint8Array; // 64 bytes (seed + public key)
}

/**
 * Wrap a @solana/web3.js Keypair as a SolanaSigner.
 * Uses tweetnacl directly for signing — no @solana/web3.js runtime dependency needed.
 */
export function keypairSignerAdapter(keypair: SolanaKeypair): SolanaSigner {
  return {
    publicKey: keypair.publicKey.toBase58(),
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return nacl.sign.detached(message, keypair.secretKey);
    },
  };
}

// ---- Wallet Adapter (browser wallets) ----

/** Minimal wallet-adapter interface */
interface SolanaWalletAdapter {
  publicKey: { toBase58(): string } | null;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Wrap a Solana wallet-adapter wallet as a SolanaSigner.
 * Works with Phantom, Solflare, etc. via the standard wallet-adapter interface.
 */
export function walletAdapterSignerAdapter(wallet: SolanaWalletAdapter): SolanaSigner {
  if (!wallet.publicKey) {
    throw new Error("walletAdapterSignerAdapter: wallet not connected (publicKey is null)");
  }
  const publicKey = wallet.publicKey.toBase58();
  return {
    publicKey,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return wallet.signMessage(message);
    },
  };
}

/**
 * Create a SolanaSigner directly from a raw Ed25519 secret key (32-byte seed or 64-byte keypair).
 */
export function rawKeypairSigner(secretKeyBytes: Uint8Array): SolanaSigner {
  let keypairBytes: Uint8Array;
  if (secretKeyBytes.length === 32) {
    // Seed — derive full keypair
    const kp = nacl.sign.keyPair.fromSeed(secretKeyBytes);
    keypairBytes = kp.secretKey;
    const publicKeyBase58 = bs58.encode(kp.publicKey);
    return {
      publicKey: publicKeyBase58,
      async sign(message: Uint8Array): Promise<Uint8Array> {
        return nacl.sign.detached(message, keypairBytes);
      },
    };
  } else if (secretKeyBytes.length === 64) {
    keypairBytes = secretKeyBytes;
    const publicKeyBase58 = bs58.encode(secretKeyBytes.slice(32));
    return {
      publicKey: publicKeyBase58,
      async sign(message: Uint8Array): Promise<Uint8Array> {
        return nacl.sign.detached(message, keypairBytes);
      },
    };
  } else {
    throw new Error(`rawKeypairSigner: expected 32 or 64 byte key, got ${secretKeyBytes.length}`);
  }
}
