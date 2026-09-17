---
name: Direct crossing identity
description: Causal identity requirements for direct consolidation entries across replay cursors and projections
---

Direct occurrence identity must be strategy-specific all the way through the final occurrence ID and candidate physical-deduplication key. Consolidation identity includes normalized frozen bounds, constituent candles, qualification/arm time, and physical crossing candle; equivalent reversal identity includes both pattern candles and the immediate trigger. A completed-bar same-candle entry uses the crossing candle itself; an unverified OHLCV replay must not invent an intrabar crossing timestamp.

**Why:** A ledger map key alone is insufficient when a later upsert recomputes the final ID through a generic patience branch. That can collapse different direct strategies or frozen setups that share an entry candle, and candidate deduplication can repeat the collapse downstream.

**How to apply:** Use one canonical direct identity representation for ledger keys, governed occurrence IDs, and candidate physical identity. Keep missing required fields as explicit diagnostics with a non-collapsing fallback. Carry the identity through audit, occurrence, candidate, modeled trade, account arbitration, batch aggregation, and Visual Review; bump governed formula/cache provenance when the semantics change.