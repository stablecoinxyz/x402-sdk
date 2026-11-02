/**
 * The EVM buyer client must produce the x402 v2 Exact EVM Permit2 payload the SBC facilitator
 * settles, for an offer a paywall >= 0.5 seller advertises.
 *
 * `facilitatorAccepts` mirrors x402-facilitator src/evm/permit2.ts `parsePermit2` (field formats,
 * spender, recipient, amount, window, sponsor extension) and the envelope check at
 * src/routes/settle.ts:693 (accepted must echo network, amount, asset, payTo, extra).
 * Signatures are real (viem private key) and checked with the facilitator's EIP-712 types.
 */
import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { createX402Client } from "../../src/evm/client.js";
import { viemSignerAdapter } from "../../src/evm/signer.js";
import { matchRequirement, resolveRequirement } from "../../src/core/requirements.js";
import { makeFetchResponse, abiEncodeUint256, fromBase64, toBase64, createMockSigner } from "../helpers.js";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const TARGET = "https://seller.test/premium";
const RPC = "https://rpc.test";
const PAY_TO = "0x1234567890123456789012345678901234567890";
const SBC_SEPOLIA = "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // test-only key
const account = privateKeyToAccount(KEY);

const witnessTypes = {
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
} as const;
const erc2612Types = {
  Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

type Json = Record<string, any>;

const offer = (over: Json = {}): Json => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  maxAmountRequired: "1000",
  resource: "/premium",
  payTo: PAY_TO,
  asset: SBC_SEPOLIA,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "permit2", name: "Stable Coin", version: "1" },
  ...over,
});

function facilitatorAccepts(p: Json, req: Json): string | true {
  const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  const uint = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
  const same = (a: unknown, b: string) => addr(a) && (a as string).toLowerCase() === b.toLowerCase();
  const a = p.accepted;
  if (a?.network !== req.network || a?.amount !== req.amount || !same(a?.asset, req.asset) || !same(a?.payTo, req.payTo)
    || a?.extra?.assetTransferMethod !== "permit2" || a?.extra?.name !== req.extra?.name || a?.extra?.version !== req.extra?.version) return "envelope";
  const auth = p.payload?.permit2Authorization;
  if (!auth) return "no permit2Authorization";
  if (typeof p.payload.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(p.payload.signature)) return "signature format";
  if (!addr(auth.from) || !addr(auth.permitted?.token) || !addr(auth.spender) || !addr(auth.witness?.to)
    || !uint(auth.permitted?.amount) || !uint(auth.nonce) || !uint(auth.deadline) || !uint(auth.witness?.validAfter)) return "field formats";
  if (!same(auth.spender, PROXY)) return "spender";
  if (!same(auth.permitted.token, req.asset) || !same(auth.witness.to, req.payTo)) return "recipient";
  if (BigInt(auth.permitted.amount) !== BigInt(req.amount)) return "amount";
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < BigInt(auth.witness.validAfter) || now > BigInt(auth.deadline)) return "window";
  const s = p.extensions?.eip2612GasSponsoring?.info;
  if (s !== undefined) {
    if (!addr(s.from) || !addr(s.asset) || !addr(s.spender) || !uint(s.amount) || !uint(s.nonce) || !uint(s.deadline)
      || typeof s.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s.signature) || s.version !== "1"
      || !same(s.from, auth.from) || !same(s.asset, auth.permitted.token) || !same(s.spender, PERMIT2)
      || BigInt(s.amount) !== BigInt(auth.permitted.amount) || BigInt(s.deadline) < BigInt(auth.deadline)) return "sponsor";
  }
  return true;
}

/** viem account as the SDK's signer, through the real viem adapter. */
function realSigner() {
  return viemSignerAdapter({
    account,
    signTypedData: (p: any) => account.signTypedData(p),
  } as any);
}

/** Seller returns `accepts` once, then `paid`; RPC answers allowance / nonces / balanceOf. */
function flow(accepts: Json[], opts: { allowance?: bigint; nonce?: bigint; paid?: { status: number; body: unknown; headers?: Record<string, string> } } = {}) {
  const sent: { header?: string } = {};
  let calls = 0;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).href;
    if (url.startsWith(TARGET)) {
      calls++;
      if (calls === 1) return makeFetchResponse(402, { x402Version: 2, accepts });
      sent.header = new Headers(init?.headers).get("payment-signature") ?? undefined;
      const paid = opts.paid ?? { status: 200, body: { ok: true } };
      return makeFetchResponse(paid.status, paid.body, paid.headers);
    }
    if (url === RPC) {
      const data: string = JSON.parse(String(init?.body)).params[0].data;
      if (data.startsWith("0xdd62ed3e")) return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(opts.allowance ?? 0n) });
      if (data.startsWith("0x7ecebe00")) return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(opts.nonce ?? 7n) });
      if (data.startsWith("0x70a08231")) return makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(10_000_000n) });
    }
    throw new Error(`Unexpected fetch to: ${url}`);
  });
  return { fetchFn, sent, payload: () => JSON.parse(fromBase64(sent.header!)) as Json };
}

describe("EVM client signs the Permit2 payload the facilitator settles", () => {
  it("payload passes the facilitator's parse and envelope checks, with the gas-sponsoring permit", async () => {
    const req = offer();
    const f = flow([req], { allowance: 0n });
    await createX402Client({ signer: realSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const p = f.payload();
    expect(facilitatorAccepts(p, req)).toBe(true);
    expect(p.extensions?.eip2612GasSponsoring?.info).toBeDefined();
    expect(p.x402Version).toBe(2);
  });

  it("Permit2 witness signature verifies with the facilitator's EIP-712 types and domain (no version)", async () => {
    const f = flow([offer()]);
    await createX402Client({ signer: realSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const { permit2Authorization: auth, signature } = f.payload().payload;
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2 },
      types: witnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: auth,
      signature,
    });
    expect(ok).toBe(true);
  });

  it("gas-sponsoring ERC-2612 permit verifies against the token's domain from the offer, spender Permit2", async () => {
    const f = flow([offer()], { allowance: 0n, nonce: 7n });
    await createX402Client({ signer: realSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const s = f.payload().extensions.eip2612GasSponsoring.info;
    expect(s.nonce).toBe("7");
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "Stable Coin", version: "1", chainId: 84532, verifyingContract: SBC_SEPOLIA },
      types: erc2612Types,
      primaryType: "Permit",
      message: { owner: account.address, spender: PERMIT2, value: BigInt(s.amount), nonce: BigInt(s.nonce), deadline: BigInt(s.deadline) },
      signature: s.signature,
    });
    expect(ok).toBe(true);
  });

  it("no gas-sponsoring permit when Permit2 already has enough allowance (a standing approval is not overwritten)", async () => {
    const f = flow([offer()], { allowance: 10n ** 30n });
    await createX402Client({ signer: realSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const p = f.payload();
    expect(p.extensions).toBeUndefined();
    expect(facilitatorAccepts(p, offer())).toBe(true);
  });

  it("the echoed `accepted` is matched by a paywall seller to the offer it was built from", async () => {
    const f = flow([offer()]);
    await createX402Client({ signer: createMockSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const resolved = resolveRequirement({ payTo: PAY_TO, amount: "1000", network: "base-sepolia" }, "test");
    expect(matchRequirement([{ resolved }], f.payload().accepted)).toBeDefined();
  });

  it("a seller's maxTimeoutSeconds is clamped: the permit deadline is at most 600 s away", async () => {
    const f = flow([offer({ maxTimeoutSeconds: 31_536_000 })]);
    await createX402Client({ signer: createMockSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    const deadline = Number(f.payload().payload.permit2Authorization.deadline);
    expect(deadline - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });

  it("refuses an offer without assetTransferMethod permit2, and signs nothing", async () => {
    const signer = createMockSigner();
    const f = flow([offer({ network: "base-sepolia", amount: undefined, extra: { name: "Stable Coin" } })]);
    await expect(createX402Client({ signer, rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET)).rejects.toThrow(/permit2/i);
    expect(signer.calls).toHaveLength(0);
  });

  it("a 202 pending reply is reported as pending, not as success", async () => {
    const tx = "0x" + "ab".repeat(32);
    const f = flow([offer()], { paid: { status: 202, body: { pending: true, payment: { txHash: tx } } } });
    const res = await createX402Client({ signer: createMockSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    expect(res.paymentResult).toMatchObject({ success: false, pending: true, txHash: tx });
  });
});

describe("EVM client reads the seller's receipt under either header name", () => {
  it("takes the txHash from an x402 v1 X-PAYMENT-RESPONSE header", async () => {
    const tx = "0x" + "cd".repeat(32);
    const receipt = toBase64(JSON.stringify({ success: true, transaction: tx }));
    const f = flow([offer()], { paid: { status: 200, body: { ok: true }, headers: { "X-PAYMENT-RESPONSE": receipt } } });
    const res = await createX402Client({ signer: createMockSigner(), rpcUrl: RPC, fetchFn: f.fetchFn }).fetch(TARGET);
    expect(res.paymentResult?.txHash).toBe(tx);
  });
});
