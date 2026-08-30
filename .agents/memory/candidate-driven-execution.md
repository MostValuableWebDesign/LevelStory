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

Historical replay response contracts must include every status and Phase 2G field emitted by the causal engine.

**Why:** Strict response validation can reject an otherwise completed worker report when a newly surfaced historical status or candidate-management field is absent from the generated OpenAPI schema.

**How to apply:** Update the OpenAPI source and regenerate derived validators/clients whenever replay output gains a status or report property; keep HTTP errors generic but preserve worker details in server diagnostics.

When a valid candidate matches a legacy OHLCV trade, reproject the authoritative trade through candidate execution if replay candles are available.

**Why:** Legacy records can encode entry at the P-candle close even though the causal candidate enters at the immediate E candle open; retaining that record distorts entry timing and can evaluate the wrong intrabar path.

**How to apply:** Preserve legacy records only as reconciliation evidence; use the candidate-owned trade for authoritative metrics and retain the exact E open plus E close in its audit.

Dashboard risk and execution projections must use the patience analysis belonging to the selected setup.

**Why:** Reversal setups can have a valid reversal-specific patience sequence while generic continuation patience is empty; mixing them creates a false qualified-without-entry invariant violation.

**How to apply:** Select reversal patience for reversal setup types and generic patience for continuation setup types before building risk, Phase 8, dashboard, and invariant inputs.