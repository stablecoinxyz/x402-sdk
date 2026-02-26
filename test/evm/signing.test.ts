import { describe, it, expect, vi } from "vitest";
import {
  getPermitNonce,
  getTokenBalance,
  signPermit,
  signSbcPayment,
  signTransferAuthorization,
} from "../../src/evm/signing.js";
import { NetworkError } from "../../src/core/errors.js";
import {
  createMockSigner,
  makeFetchResponse,
  abiEncodeUint256,
  MOCK_SIG,
} from "../helpers.js";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TOKEN = "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16";
const SPENDER = "0x124b082e8df36258198da4caa3b39c7dfa64d9ce";
const RPC_URL = "https://sepolia.base.org";

// ---- getPermitNonce ----

describe("getPermitNonce", () => {
  it("sends eth_call with nonces(address) selector 0x7ecebe00", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(0n) })
    );

    await getPermitNonce(RPC_URL, TOKEN, OWNER, fetchFn);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(RPC_URL);
    const body = JSON.parse(init.body);
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(TOKEN);
    expect(body.params[0].data).toMatch(/^0x7ecebe00/);
    // Address is padded to 32 bytes (64 hex chars) after selector
    const addrPart = body.params[0].data.slice(10); // skip 0x7ecebe00
    expect(addrPart).toHaveLength(64);
    expect(addrPart).toMatch(/^0+/); // left-padded with zeros
    expect(addrPart.slice(-40).toLowerCase()).toBe(OWNER.toLowerCase().slice(2));
  });

  it("correctly parses returned uint256 nonce", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(42n) })
    );
    const nonce = await getPermitNonce(RPC_URL, TOKEN, OWNER, fetchFn);
    expect(nonce).toBe(42n);
  });

  it("handles nonce = 0 (0x result)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: "0x" })
    );
    const nonce = await getPermitNonce(RPC_URL, TOKEN, OWNER, fetchFn);
    expect(nonce).toBe(0n);
  });

  it("propagates RPC error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } })
    );
    await expect(getPermitNonce(RPC_URL, TOKEN, OWNER, fetchFn)).rejects.toThrow("execution reverted");
  });
});

// ---- getTokenBalance ----

describe("getTokenBalance", () => {
  it("sends eth_call with balanceOf(address) selector 0x70a08231", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(5_000_000n) })
    );

    await getTokenBalance(RPC_URL, TOKEN, OWNER, fetchFn);

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.params[0].data).toMatch(/^0x70a08231/);
  });

  it("returns balance as bigint", async () => {
    const balance = 1_234_567n;
    const fetchFn = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(balance) })
    );
    const result = await getTokenBalance(RPC_URL, TOKEN, OWNER, fetchFn);
    expect(result).toBe(balance);
  });
});

// ---- signPermit ----

describe("signPermit", () => {
  function makeNonceFetch(nonce: bigint) {
    return vi.fn().mockResolvedValue(
      makeFetchResponse(200, { jsonrpc: "2.0", id: 1, result: abiEncodeUint256(nonce) })
    );
  }

  it("fetches permit nonce and includes it in authorization", async () => {
    const signer = createMockSigner(OWNER);
    const nonce = 7n;

    const result = await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "1000000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      fetchFn: makeNonceFetch(nonce),
    });

    expect(result.payload.authorization.nonce).toBe(nonce.toString());
  });

  it("constructs EIP-712 domain with token as verifyingContract", async () => {
    const signer = createMockSigner(OWNER);

    await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "500000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      fetchFn: makeNonceFetch(0n),
    });

    const { domain } = signer.calls[0];
    expect(domain.name).toBe("SBC");
    expect(domain.chainId).toBe(84532); // base-sepolia
    expect(domain.verifyingContract).toBe(TOKEN); // token, NOT facilitator
    expect(domain.version).toBe("1");
  });

  it("constructs correct Permit types structure", async () => {
    const signer = createMockSigner(OWNER);

    await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "1000000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      fetchFn: makeNonceFetch(0n),
    });

    const { types, primaryType } = signer.calls[0];
    expect(primaryType).toBe("Permit");
    const permitFields = (types as Record<string, Array<{ name: string; type: string }>>)["Permit"];
    expect(permitFields.map((f) => f.name)).toEqual(["owner", "spender", "value", "nonce", "deadline"]);
  });

  it("message.value is BigInt of the value string", async () => {
    const signer = createMockSigner(OWNER);

    await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "999999",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      fetchFn: makeNonceFetch(0n),
    });

    const { message } = signer.calls[0];
    expect(message.value).toBe(999999n);
  });

  it("returns authorization with from/to/value/validBefore/nonce and full signature", async () => {
    const signer = createMockSigner(OWNER);

    const result = await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "1000000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      fetchFn: makeNonceFetch(0n),
    });

    expect(result.payload.authorization.from).toBe(OWNER);
    expect(result.payload.authorization.to).toBe(SPENDER);
    expect(result.payload.authorization.value).toBe("1000000");
    expect(typeof result.payload.authorization.validBefore).toBe("number");
    expect(result.payload.authorization.nonce).toBe("0");
    expect(result.payload.signature).toBe(MOCK_SIG);
  });

  it("throws NetworkError when RPC URL is missing for radius", async () => {
    const signer = createMockSigner(OWNER);

    await expect(signPermit(signer, {
      network: "radius",
      spender: SPENDER,
      value: "1000000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      // no rpcUrlOverride, and radius has empty rpcUrl in SUPPORTED_NETWORKS
    })).rejects.toThrow(NetworkError);
  });

  it("validBefore is approximately now + validForSeconds", async () => {
    const signer = createMockSigner(OWNER);
    const before = Math.floor(Date.now() / 1000);

    const result = await signPermit(signer, {
      network: "base-sepolia",
      spender: SPENDER,
      value: "1000000",
      tokenAddress: TOKEN,
      tokenName: "SBC",
      validForSeconds: 300,
      fetchFn: makeNonceFetch(0n),
    });

    const after = Math.floor(Date.now() / 1000);
    expect(result.payload.authorization.validBefore).toBeGreaterThanOrEqual(before + 300);
    expect(result.payload.authorization.validBefore).toBeLessThanOrEqual(after + 300);
  });
});

// ---- signSbcPayment ----

describe("signSbcPayment", () => {
  it("constructs domain with facilitator as verifyingContract", async () => {
    const signer = createMockSigner(OWNER);

    const result = await signSbcPayment(signer, {
      network: "base-sepolia",
      to: "0xrecipient000000000000000000000000000000000",
      amount: "500000",
      facilitatorAddress: SPENDER,
    });

    const { domain } = signer.calls[0];
    expect(domain.name).toBe("SBC x402 Facilitator");
    expect(domain.verifyingContract).toBe(SPENDER); // facilitator, not token
    expect(domain.chainId).toBe(84532);
    expect(domain.version).toBe("1");
    expect(result.payload.from).toBe(OWNER);
  });

  it("passes amount and addresses as BigInt in message", async () => {
    const signer = createMockSigner(OWNER);

    await signSbcPayment(signer, {
      network: "base",
      to: "0xrecipient000000000000000000000000000000000",
      amount: "1000000000000000000",
      facilitatorAddress: SPENDER,
    });

    const { message } = signer.calls[0];
    expect(message.amount).toBe(1000000000000000000n);
    expect(typeof message.nonce).toBe("bigint");
    expect(typeof message.deadline).toBe("bigint");
  });

  it("nonce is a timestamp (prevents replay)", async () => {
    const signer = createMockSigner(OWNER);
    const before = Math.floor(Date.now() / 1000);

    const result = await signSbcPayment(signer, {
      network: "base",
      to: "0xrecipient000000000000000000000000000000000",
      amount: "100",
      facilitatorAddress: SPENDER,
    });

    const after = Math.floor(Date.now() / 1000);
    expect(result.payload.nonce).toBeGreaterThanOrEqual(before);
    expect(result.payload.nonce).toBeLessThanOrEqual(after);
  });

  it("uses Payment as primaryType", async () => {
    const signer = createMockSigner(OWNER);
    await signSbcPayment(signer, {
      network: "base",
      to: "0xrecipient",
      amount: "100",
      facilitatorAddress: SPENDER,
    });
    expect(signer.calls[0].primaryType).toBe("Payment");
  });
});

// ---- signTransferAuthorization ----

describe("signTransferAuthorization", () => {
  it("constructs domain with token as verifyingContract", async () => {
    const signer = createMockSigner(OWNER);

    await signTransferAuthorization(signer, {
      network: "base",
      to: "0xrecipient",
      value: "1000000",
      assetAddress: TOKEN,
      tokenName: "USD Coin",
      tokenVersion: "2",
    });

    const { domain } = signer.calls[0];
    expect(domain.verifyingContract).toBe(TOKEN);
    expect(domain.name).toBe("USD Coin");
    expect(domain.version).toBe("2");
    expect(domain.chainId).toBe(8453); // base mainnet
  });

  it("uses TransferWithAuthorization as primaryType", async () => {
    const signer = createMockSigner(OWNER);
    await signTransferAuthorization(signer, {
      network: "base",
      to: "0xrecipient",
      value: "1000000",
      assetAddress: TOKEN,
      tokenName: "USD Coin",
    });
    expect(signer.calls[0].primaryType).toBe("TransferWithAuthorization");
  });

  it("validAfter is in the past (allows immediate use)", async () => {
    const signer = createMockSigner(OWNER);
    const before = Math.floor(Date.now() / 1000);

    const result = await signTransferAuthorization(signer, {
      network: "base",
      to: "0xrecipient",
      value: "100",
      assetAddress: TOKEN,
      tokenName: "USD Coin",
    });

    expect(Number(result.authorization.validAfter)).toBeLessThan(before);
  });

  it("nonce is a 32-byte hex string (bytes32)", async () => {
    const signer = createMockSigner(OWNER);
    const result = await signTransferAuthorization(signer, {
      network: "base",
      to: "0xrecipient",
      value: "100",
      assetAddress: TOKEN,
      tokenName: "USD Coin",
    });
    // bytes32 = 0x + 64 hex chars = 66 total
    expect(result.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("two sequential calls produce different nonces", async () => {
    const signer = createMockSigner(OWNER);
    const params = { network: "base", to: "0xr", value: "100", assetAddress: TOKEN, tokenName: "USD Coin" };
    const r1 = await signTransferAuthorization(signer, params);
    const r2 = await signTransferAuthorization(signer, params);
    expect(r1.authorization.nonce).not.toBe(r2.authorization.nonce);
  });
});
