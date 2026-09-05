---
name: Consolidation entry guard
description: The causal boundary and enforcement rule for consolidation-zone entries.
---

The consolidation entry guard must freeze its zone from completed, machine-visible five-minute candles available no later than P, or no later than a completed breakout for a breakout-pullback sequence. A P candle inside that frozen zone is evidence only. Execution requires the immediate completed E to reach the effective threshold `max(P.high + buffer, zoneHigh + 1 tick)` for long or `min(P.low - buffer, zoneLow - 1 tick)` for short, close strictly outside the frozen zone, have a strictly outside modeled fill and finalized NTZ, satisfy the causal consolidation edge, and open before the entry cutoff. E may open inside and wick-overlap the zone; full-range clearance is evidence only. A failed immediate E expires that P; later candles cannot confirm it.

When a historical audit guard is reused for a different occurrence, retain the frozen zone identity but recompute every P/E-dependent boolean, threshold, disposition, and rejection detail from the occurrence-local candles. Never patch only the threshold: stale lifecycle and rejection fields can otherwise reject a valid later occurrence or display contradictory evidence.

**Why:** Letting P/E or later candles expand the zone or retroactively confirm a failed immediate E converts a causal replay into look-ahead and can create trades that were not eligible at the decision candle. Reusing stale P/E booleans creates the inverse failure: a later occurrence can display one threshold while still carrying an earlier occurrence's rejection.

**How to apply:** Keep the evidence additive and optional for legacy fixtures, but enforce the same eligibility result immediately before replay trade creation and again during candidate projection. Route reconciliation through candidate projection so rejected signals cannot affect authoritative trades or metrics.