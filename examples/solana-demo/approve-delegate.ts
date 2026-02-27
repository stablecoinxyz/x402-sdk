/**
 * One-time setup: approve the x402 facilitator as delegate on your SBC token account.
 *
 * This must be run once per wallet before Solana x402 payments work.
 * The facilitator uses this delegation to execute transfers on your behalf (non-custodial).
 *
 * Usage:
 *   npx tsx --env-file=.env approve-delegate.ts
 */

import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  approve,
} from "@solana/spl-token";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY env var required");
  process.exit(1);
}

// SBC token mint on Solana mainnet
const SBC_MINT = new PublicKey("DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA");
// x402 facilitator address (the delegate)
const FACILITATOR = new PublicKey("2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K");
// How much to approve — set high so you don't need to re-approve often (1000 SBC)
const APPROVE_AMOUNT = BigInt(1_000 * 1e9);

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const secretKey = bs58.decode(PRIVATE_KEY);
const keypair = Keypair.fromSecretKey(secretKey);
const connection = new Connection(RPC_URL, "confirmed");

console.log("Wallet     :", keypair.publicKey.toBase58());
console.log("Facilitator:", FACILITATOR.toBase58());
console.log("Approving  :", Number(APPROVE_AMOUNT) / 1e9, "SBC as delegate allowance");
console.log();

const tokenAccount = await getAssociatedTokenAddress(SBC_MINT, keypair.publicKey);
console.log("Token account:", tokenAccount.toBase58());

const sig = await approve(
  connection,
  keypair,          // fee payer + owner
  tokenAccount,     // token account to set delegate on
  FACILITATOR,      // delegate
  keypair,          // owner
  APPROVE_AMOUNT
);

console.log();
console.log("✅ Delegate approved!");
console.log("   Transaction:", sig);
console.log("   Explorer:   https://explorer.solana.com/tx/" + sig);
console.log();
console.log("You can now run: pnpm start");
