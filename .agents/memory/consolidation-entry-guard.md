---
name: Consolidation entry guard
description: The causal boundary and enforcement rule for consolidation-zone entries.
---

The consolidation entry guard must freeze its zone from completed, machine-visible five-minute candles available no later than P, or no later than a completed breakout for a breakout-pullback sequence. A P candle inside that frozen zone is evidence only. Execution requires the immediate completed E to reach the governed confirmation buffer, have its entire range strictly outside the frozen zone and finalized NTZ, satisfy the causal consolidation edge, and open before the entry cutoff. A failed immediate E expires that P; later candles cannot confirm it.

**Why:** Letting P/E or later candles expand the zone or retroactively confirm a failed immediate E converts a causal replay into look-ahead and can create trades that were not eligible at the decision candle.

**How to apply:** Keep the evidence additive and optional for legacy fixtures, but enforce the same eligibility result immediately before replay trade creation and again during candidate projection. Route reconciliation through candidate projection so rejected signals cannot affect authoritative trades or metrics.