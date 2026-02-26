import { describe, it, expect, vi } from "vitest";
import { createSolanaX402Client } from "../../src/solana/client.js";
import { rawKeypairSigner } from "../../src/solana/signer.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { make402Body, makeFetchResponse, fromBase64 } from "../helpers.js";

const TARGET_URL = "https://api.example.com/premium";
const FACILITATOR_URL = "https://f.test";
const TEST_KEYPAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
const TEST_SIGNER = rawKeypairSigner(TEST_KEYPAIR.secretKey);

// vitest mock.calls entries are variadic — use unknown[] and cast
function getUrl(args: unknown[]): string {
  const u = args[0] as RequestInfo | URL;
  return typeof u === "string" ? u : u instanceof URL ? u.href : (u as Request).url;
}

function getInit(args: unknown[]): RequestInit | undefined {
  return args[1] as RequestInit | undefined;
}

function makeSolanaFlowFetch(opts: {
  verify?: { isValid: boolean; invalidReason?: string };
  settle?: { success: boolean; txHash?: string; error?: string };
}) {
  const {
    verify = { isValid: true },
    settle = { success: true, txHash: "0xsolanatx" },
  } = opts;

  let apiCallCount = 0;

  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = getUrl([input]);
    if (url.startsWith(TARGET_URL)) {
      apiCallCount++;
      if (apiCallCount === 1)
        return makeFetchResponse(402, make402Body({ network: "solana", asset: bs58.encode(new Uint8Array(32).fill(10)) }));
      return makeFetchResponse(200, { data: "solana premium" });
    }
    if (url.endsWith("/verify")) return makeFetchResponse(200, verify);
    if (url.endsWith("/settle")) return makeFetchResponse(200, settle);
    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

describe("createSolanaX402Client — non-402 passthrough", () => {
  it("returns 200 response unchanged without calling signer", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFetchResponse(200, { hello: "solana" }));
    const client = createSolanaX402Client({ signer: TEST_SIGNER, fetchFn });
    const res = await client.fetch(TARGET_URL);
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("createSolanaX402Client — full payment flow", () => {
  it("completes payment and returns paymentResult", async () => {
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn: makeSolanaFlowFetch({}),
    });
    const res = await client.fetch(TARGET_URL);
    expect(res.status).toBe(200);
    expect(res.paymentResult?.success).toBe(true);
    expect(res.paymentResult?.txHash).toBe("0xsolanatx");
    expect(res.paymentResult?.network).toBe("solana");
  });

  it("sends PAYMENT-SIGNATURE with a valid Solana payment payload", async () => {
    const fetchFn = makeSolanaFlowFetch({});
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const apiCalls = fetchFn.mock.calls.filter((args) => getUrl(args).startsWith(TARGET_URL));
    const secondCallInit = getInit(apiCalls[1]);
    const headers = secondCallInit?.headers as Record<string, string>;
    expect(headers["PAYMENT-SIGNATURE"]).toBeDefined();

    const outerPayload = JSON.parse(fromBase64(headers["PAYMENT-SIGNATURE"]));
    expect(outerPayload.accepted.network).toBe("solana:mainnet-beta");
    expect(outerPayload.accepted.scheme).toBe("exact");
    expect(outerPayload.payload.from).toBe(TEST_SIGNER.publicKey);
    expect(typeof outerPayload.payload.signature).toBe("string");
  });

  it("signature in the payload is cryptographically valid (verifiable with nacl)", async () => {
    const { constructMessage } = await import("../../src/solana/signing.js");
    const fetchFn = makeSolanaFlowFetch({});
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const apiCalls = fetchFn.mock.calls.filter((args) => getUrl(args).startsWith(TARGET_URL));
    const secondInit = getInit(apiCalls[1]);
    const outerPayload = JSON.parse(fromBase64((secondInit?.headers as Record<string, string>)["PAYMENT-SIGNATURE"]));
    const p = outerPayload.payload;

    const msg = constructMessage({ from: p.from, to: p.to, amount: p.amount, nonce: p.nonce, deadline: p.deadline });
    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(msg),
      bs58.decode(p.signature),
      TEST_KEYPAIR.publicKey
    );
    expect(isValid).toBe(true);
  });

  it("calls facilitator verify before settle", async () => {
    const fetchFn = makeSolanaFlowFetch({});
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn,
    });
    await client.fetch(TARGET_URL);

    const allUrls = fetchFn.mock.calls.map((args) => getUrl(args));
    const verifyIdx = allUrls.findIndex((u) => u.endsWith("/verify"));
    const settleIdx = allUrls.findIndex((u) => u.endsWith("/settle"));
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(settleIdx).toBeGreaterThan(verifyIdx);
  });

  it("throws when verify returns isValid:false", async () => {
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn: makeSolanaFlowFetch({ verify: { isValid: false, invalidReason: "Invalid signature" } }),
    });
    await expect(client.fetch(TARGET_URL)).rejects.toThrow("Invalid signature");
  });

  it("throws when settle fails", async () => {
    const client = createSolanaX402Client({
      signer: TEST_SIGNER,
      facilitatorUrl: FACILITATOR_URL,
      fetchFn: makeSolanaFlowFetch({ settle: { success: false, error: "Insufficient balance" } }),
    });
    await expect(client.fetch(TARGET_URL)).rejects.toThrow("Insufficient balance");
  });
});
