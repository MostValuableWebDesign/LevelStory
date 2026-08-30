---
name: Candidate-driven execution
description: Historical replay execution ownership and honest OHLCV entry limitations
---

Eligible confirmed historical candidates must initiate their own deterministic Shadow Mode entry simulation. A legacy modeled-trade collection may reconcile duplicates and regressions, but its absence must never downgrade a valid candidate.

**Why:** The legacy execution loop could skip valid confirmed candidates because of overlapping-position state, making reporting depend on a pre-existing trade rather than the causal signal.

**How to apply:** Use the exact canonical P→E identity and immutable replay candle evidence. For OHLCV-only data, use the explicit confirmation-threshold assumption, never fabricate bid/ask quotes, and leave exits open when stop/target evidence is not authoritative.

Realized performance must be computed from finalized trades only; keep open and ambiguous dispositions visible in the report with separate counts.

**Why:** Candidate-driven entries can be valid while management evidence is incomplete, so counting them as zero-dollar outcomes would distort win rate, expectancy, and drawdown.

**How to apply:** Separate entered, finalized, open, ambiguous, and unscored counts from realized metrics in every historical report.

Candidate-driven OHLCV management must use the E candle for entry evidence only; exit replay starts with the first completed candle after E.

**Why:** The modeled fill is observed at E close, so using E's earlier high/low would leak pre-entry movement into stop, target, or runner outcomes.

**How to apply:** Keep the immediate trigger candle in the candidate audit, but pass only post-E candles to the management simulator.