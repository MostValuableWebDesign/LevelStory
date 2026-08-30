---
name: Candidate-driven execution
description: Historical replay execution ownership and honest OHLCV entry limitations
---

Eligible confirmed historical candidates must initiate their own deterministic Shadow Mode entry simulation. A legacy modeled-trade collection may reconcile duplicates and regressions, but its absence must never downgrade a valid candidate.

**Why:** The legacy execution loop could skip valid confirmed candidates because of overlapping-position state, making reporting depend on a pre-existing trade rather than the causal signal.

**How to apply:** Use the exact canonical P→E identity and immutable replay candle evidence. For OHLCV-only data, use the explicit confirmation-threshold assumption, never fabricate bid/ask quotes, and leave exits open when stop/target evidence is not authoritative.