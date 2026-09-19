---
name: Replay chronology provenance
description: Execution replay must preserve the original chronology mode and frozen-zone identity rather than infer them from candles.
---

Replay provenance must explicitly distinguish ordered intrabar, deterministic candle-open, deterministic later-candle, and ambiguous OHLC outcomes. A single canonical frozen-consolidation identity must travel with the occurrence, candidate, execution evidence, Visual Review input, and replay validation; legacy evidence without these fields is stale.

**Why:** Reconstructing chronology from OHLC candles can change equal-timestamp entry/stop outcomes, while geometry-only zone strings can collide across contracts, dates, strategies, or causal ranges.

**How to apply:** When execution semantics or frozen-zone inputs change, update the evidence schema, reject incompatible persisted replay inputs, and bump every strategy, batch, funnel, route, and Visual Review cache version that can retain the affected result.