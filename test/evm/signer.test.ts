import { describe, it, expect, vi } from "vitest";
import { viemSignerAdapter, ethersSignerAdapter } from "../../src/evm/signer.js";
import type { TypedDataDomain, TypedDataField } from "../../src/evm/signer.js";
import { MOCK_SIG } from "../helpers.js";

const DOMAIN: TypedDataDomain = {
  name: "SBC",
  version: "1",
  chainId: 84532,
  verifyingContract: "0xtoken",
};
const TYPES: Record<string, TypedDataField[]> = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
  ],
};
const MESSAGE = { owner: "0xowner", spender: "0xspender" };

describe("viemSignerAdapter", () => {
  it("exposes the wallet account address", () => {
    const wc = {
      account: { address: "0xDeadBeef00000000000000000000000000000000" },
      signTypedData: vi.fn().mockResolvedValue(MOCK_SIG),
    };
    const signer = viemSignerAdapter(wc);
    expect(signer.address).toBe("0xDeadBeef00000000000000000000000000000000");
  });

  it("throws when walletClient has no account", () => {
    const wc = { account: null, signTypedData: vi.fn() };
    expect(() => viemSignerAdapter(wc)).toThrow(/no account/i);
  });

  it("delegates signTypedData with correct parameters", async () => {
    const signFn = vi.fn().mockResolvedValue(MOCK_SIG);
    const wc = {
      account: { address: "0xabc" },
      signTypedData: signFn,
    };
    const signer = viemSignerAdapter(wc);

    const result = await signer.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Permit",
      message: MESSAGE,
    });

    expect(result).toBe(MOCK_SIG);
    expect(signFn).toHaveBeenCalledWith({
      account: { address: "0xabc" },
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Permit",
      message: MESSAGE,
    });
  });

  it("propagates signing errors", async () => {
    const wc = {
      account: { address: "0xabc" },
      signTypedData: vi.fn().mockRejectedValue(new Error("User rejected")),
    };
    const signer = viemSignerAdapter(wc);

    await expect(signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Permit", message: MESSAGE }))
      .rejects.toThrow("User rejected");
  });
});

describe("ethersSignerAdapter", () => {
  it("resolve() returns signer with the wallet address", async () => {
    const ethersSigner = {
      getAddress: vi.fn().mockResolvedValue("0xEthers0000000000000000000000000000000000"),
      signTypedData: vi.fn().mockResolvedValue(MOCK_SIG),
    };
    const adapter = ethersSignerAdapter(ethersSigner);
    const signer = await adapter.resolve();
    expect(signer.address).toBe("0xEthers0000000000000000000000000000000000");
  });

  it("resolved signer delegates signTypedData with domain, types, message", async () => {
    const signFn = vi.fn().mockResolvedValue(MOCK_SIG);
    const ethersSigner = {
      getAddress: vi.fn().mockResolvedValue("0xabc"),
      signTypedData: signFn,
    };
    const signer = await ethersSignerAdapter(ethersSigner).resolve();

    await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Permit", message: MESSAGE });

    // ethers v6 does not receive primaryType
    expect(signFn).toHaveBeenCalledWith(DOMAIN, TYPES, MESSAGE);
  });

  it("each resolve() call invokes getAddress", async () => {
    const getAddress = vi.fn().mockResolvedValue("0xabc");
    const ethersSigner = { getAddress, signTypedData: vi.fn().mockResolvedValue(MOCK_SIG) };

    await ethersSignerAdapter(ethersSigner).resolve();
    await ethersSignerAdapter(ethersSigner).resolve();

    expect(getAddress).toHaveBeenCalledTimes(2);
  });
});
