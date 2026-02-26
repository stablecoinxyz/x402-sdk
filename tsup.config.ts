import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "evm/index": "src/evm/index.ts",
    "solana/index": "src/solana/index.ts",
    "middleware/index": "src/middleware/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  clean: true,
  treeshake: true,
  external: [
    "react",
    "react/jsx-runtime",
    "viem",
    "@solana/web3.js",
    "@solana/spl-token",
    "express",
    "next",
    "ethers",
  ],
  noExternal: ["tweetnacl", "bs58"],
});
