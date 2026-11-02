---
"@stablecoin.xyz/x402": minor
---

EVM client: the `maxAmount` USD cap now converts with the decimals of the token being paid, not the network default. Before, a USDC (6 decimals) offer on Base was compared against a cap scaled by 18 decimals, so offers far above the cap were accepted. With a cap set, an offer in a token this SDK does not list is now refused, since its USD value is unknown. Cheapest-offer selection compares offers in USD across tokens of different decimals.

Both clients: `maxAmount` must be a plain non-negative decimal string ("0.05"). Values such as "0x10", "1.5.5" or "1e6" now throw instead of being read as some other number.
