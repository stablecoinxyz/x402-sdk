/**
 * EvmSigner — generic interface for EIP-712 signing.
 * Adapters for viem WalletClient and ethers.js Signer.
 */

export type Hex = `0x${string}`;

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
}

export interface TypedDataField {
  name: string;
  type: string;
}

export interface SignTypedDataParams {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Generic EVM signer interface.
 * Any wallet that can sign EIP-712 typed data implements this.
 */
export interface EvmSigner {
  address: string;
  signTypedData(params: SignTypedDataParams): Promise<Hex>;
}

// ---- Viem adapter ----

/** Minimal viem WalletClient interface (subset we need). */
interface ViemWalletClient {
  account: { address: string } | null | undefined;
  signTypedData(params: {
    account: { address: string };
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/**
 * Wrap a viem WalletClient as an EvmSigner.
 * Works with EOA wallets, smart account clients, and embedded wallets — all
 * expose the same signTypedData interface.
 */
export function viemSignerAdapter(walletClient: ViemWalletClient): EvmSigner {
  const account = walletClient.account;
  if (!account) {
    throw new Error("viemSignerAdapter: walletClient has no account connected");
  }
  return {
    address: account.address,
    signTypedData: ({ domain, types, primaryType, message }) =>
      walletClient.signTypedData({ account, domain, types, primaryType, message }),
  };
}

// ---- Ethers.js v6 adapter ----

/** Minimal ethers v6 Signer interface (subset we need). */
interface EthersSigner {
  getAddress(): Promise<string>;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string>;
}

/**
 * Wrap an ethers.js v6 Signer as an EvmSigner.
 * Ethers v6: signer.signTypedData(domain, types, value)
 */
export function ethersSignerAdapter(signer: EthersSigner): {
  /** Call this to get a fully-resolved EvmSigner (async because getAddress() is async). */
  resolve(): Promise<EvmSigner>;
} {
  return {
    async resolve(): Promise<EvmSigner> {
      const address = await signer.getAddress();
      return {
        address,
        signTypedData: async ({ domain, types, primaryType: _primaryType, message }) => {
          const sig = await signer.signTypedData(domain, types, message);
          return sig as Hex;
        },
      };
    },
  };
}
