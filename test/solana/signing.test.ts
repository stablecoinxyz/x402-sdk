import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  constructMessage,
  signSolanaPayment,
  verifySolanaSignature,
} from "../../src/solana/signing.js";
import {
  keypairSignerAdapter,
  rawKeypairSigner,
} from "../../src/solana/signer.js";

// Generate a deterministic test keypair
const TEST_KEYPAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const TEST_PUBLIC_KEY = bs58.encode(TEST_KEYPAIR.publicKey);
const TEST_RECIPIENT = bs58.encode(new Uint8Array(32).fill(2));

// ---- constructMessage ----

describe("constructMessage", () => {
  it("produces correct pipe-delimited format", () => {
    const msg = constructMessage({
      from: "FromKey111",
      to: "ToKey222",
      amount: "50000000",
      nonce: "1706000000",
      deadline: 1706000300,
    });
    expect(msg).toBe("from:FromKey111|to:ToKey222|amount:50000000|nonce:1706000000|deadline:1706000300");
  });

  it("has no extra whitespace or quotes", () => {
    const msg = constructMessage({ from: "A", to: "B", amount: "1", nonce: "2", deadline: 3 });
    expect(msg).not.toContain(" ");
    expect(msg).not.toContain('"');
  });

  it("fields appear in the canonical order: from, to, amount, nonce, deadline", () => {
    const msg = constructMessage({ from: "F", to: "T", amount: "A", nonce: "N", deadline: 0 });
    const order = ["from:", "to:", "amount:", "nonce:", "deadline:"];
    let prev = -1;
    for (const marker of order) {
      const idx = msg.indexOf(marker);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });
});

// ---- signSolanaPayment ----

describe("signSolanaPayment", () => {
  it("produces a valid Ed25519 signature verifiable with tweetnacl", async () => {
    const signer = keypairSignerAdapter({
      publicKey: {
        toBase58: () => TEST_PUBLIC_KEY,
        toBytes: () => TEST_KEYPAIR.publicKey,
      },
      secretKey: TEST_KEYPAIR.secretKey,
    });

    const { payload } = await signSolanaPayment(signer, {
      to: TEST_RECIPIENT,
      amount: "50000000",
      validForSeconds: 300,
    });

    // Reconstruct the message and verify
    const msg = constructMessage({
      from: payload.from,
      to: payload.to,
      amount: payload.amount,
      nonce: payload.nonce,
      deadline: payload.deadline,
    });

    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(msg),
      bs58.decode(payload.signature),
      TEST_KEYPAIR.publicKey
    );

    expect(isValid).toBe(true);
  });

  it("sets deadline approximately now + validForSeconds", async () => {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });

    const before = Math.floor(Date.now() / 1000);
    const { payload } = await signSolanaPayment(signer, {
      to: TEST_RECIPIENT,
      amount: "1000",
      validForSeconds: 600,
    });
    const after = Math.floor(Date.now() / 1000);

    expect(payload.deadline).toBeGreaterThanOrEqual(before + 600);
    expect(payload.deadline).toBeLessThanOrEqual(after + 600);
  });

  it("nonce is a string (timestamp)", async () => {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });

    const { payload } = await signSolanaPayment(signer, { to: TEST_RECIPIENT, amount: "1" });

    expect(typeof payload.nonce).toBe("string");
    expect(Number(payload.nonce)).toBeGreaterThan(0);
  });

  it("from matches signer public key", async () => {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });

    const { payload } = await signSolanaPayment(signer, { to: TEST_RECIPIENT, amount: "1" });
    expect(payload.from).toBe(TEST_PUBLIC_KEY);
  });
});

// ---- verifySolanaSignature ----

describe("verifySolanaSignature", () => {
  async function makeSignedPayload(amount = "50000000") {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });
    const { payload } = await signSolanaPayment(signer, { to: TEST_RECIPIENT, amount });
    return payload;
  }

  it("returns true for a validly signed payload", async () => {
    const payload = await makeSignedPayload();
    expect(await verifySolanaSignature(payload)).toBe(true);
  });

  it("returns false when amount is tampered after signing", async () => {
    const payload = await makeSignedPayload("50000000");
    const tampered = { ...payload, amount: "99999999" };
    expect(await verifySolanaSignature(tampered)).toBe(false);
  });

  it("returns false when recipient is tampered", async () => {
    const payload = await makeSignedPayload();
    const tampered = { ...payload, to: bs58.encode(new Uint8Array(32).fill(3)) };
    expect(await verifySolanaSignature(tampered)).toBe(false);
  });

  it("returns false when deadline is tampered", async () => {
    const payload = await makeSignedPayload();
    const tampered = { ...payload, deadline: payload.deadline + 1000 };
    expect(await verifySolanaSignature(tampered)).toBe(false);
  });

  it("returns false for a signature from a different keypair", async () => {
    // Sign with keypair B
    const keypairB = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const pubKeyB = bs58.encode(keypairB.publicKey);

    const signerB = keypairSignerAdapter({
      publicKey: { toBase58: () => pubKeyB, toBytes: () => keypairB.publicKey },
      secretKey: keypairB.secretKey,
    });
    const { payload } = await signSolanaPayment(signerB, { to: TEST_RECIPIENT, amount: "100" });

    // Swap the `from` to keypair A's address — signature won't verify
    const spoofed = { ...payload, from: TEST_PUBLIC_KEY };
    expect(await verifySolanaSignature(spoofed)).toBe(false);
  });

  it("returns false for an invalid base58 signature", async () => {
    const payload = await makeSignedPayload();
    const invalid = { ...payload, signature: "not-valid-base58!!!" };
    expect(await verifySolanaSignature(invalid)).toBe(false);
  });
});

// ---- keypairSignerAdapter & rawKeypairSigner ----

describe("keypairSignerAdapter", () => {
  it("exposes correct public key", () => {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });
    expect(signer.publicKey).toBe(TEST_PUBLIC_KEY);
  });

  it("produces verifiable signatures", async () => {
    const signer = keypairSignerAdapter({
      publicKey: { toBase58: () => TEST_PUBLIC_KEY, toBytes: () => TEST_KEYPAIR.publicKey },
      secretKey: TEST_KEYPAIR.secretKey,
    });

    const msg = new TextEncoder().encode("hello x402");
    const sig = await signer.sign(msg);
    expect(nacl.sign.detached.verify(msg, sig, TEST_KEYPAIR.publicKey)).toBe(true);
  });
});

describe("rawKeypairSigner", () => {
  it("accepts 64-byte secret key and exposes correct public key", () => {
    const signer = rawKeypairSigner(TEST_KEYPAIR.secretKey);
    expect(signer.publicKey).toBe(TEST_PUBLIC_KEY);
  });

  it("accepts 32-byte seed and derives correct public key", () => {
    const seed = TEST_KEYPAIR.secretKey.slice(0, 32);
    const signer = rawKeypairSigner(seed);
    expect(signer.publicKey).toBe(TEST_PUBLIC_KEY);
  });

  it("throws for invalid key length", () => {
    expect(() => rawKeypairSigner(new Uint8Array(16))).toThrow(/32 or 64/);
  });

  it("64-byte and 32-byte seed signers produce identical signatures", async () => {
    const seed = TEST_KEYPAIR.secretKey.slice(0, 32);
    const s1 = rawKeypairSigner(TEST_KEYPAIR.secretKey);
    const s2 = rawKeypairSigner(seed);

    const msg = new TextEncoder().encode("test message");
    const sig1 = await s1.sign(msg);
    const sig2 = await s2.sign(msg);

    expect(bs58.encode(sig1)).toBe(bs58.encode(sig2));
  });
});
