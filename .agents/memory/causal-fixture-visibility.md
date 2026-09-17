---
name: Causal fixture visibility
description: Production replay fixtures must match cursor-visible candle boundaries when building direct strategy evidence.
---

Replay snapshots expose completed candles through the current candle's close, but the next candle opens at that same timestamp and must remain hidden until its own close. Synthetic fixtures should place the setup pair early enough for the immediate entry candle to remain before the governed cutoff, and tests should avoid treating `openTime <= cursor` as equivalent to replay visibility.

**Why:** Including the next candle while constructing a fixture can make an equivalent-candle pattern appear qualified through future evidence, while the real replay correctly sees only the setup pair.

**How to apply:** Build fixture prefixes using the same completed-candle visibility rule as replay, keep the trigger candle adjacent to the setup pair, and validate audit plus occurrence timestamps before asserting candidate projection.