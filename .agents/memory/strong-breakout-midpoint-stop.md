---
name: Strong Breakout midpoint stop identity
description: The frozen-zone midpoint-reentry stop applies only to canonical Strong Breakout consolidation occurrences, not extended consolidation aliases or equivalent reversals.
---

The midpoint-reentry stop must be selected from the explicit causal occurrence identity. Canonical `CONSOLIDATION_BREAKOUT_CONTINUATION` represents Strong Breakout, while an explicit `EXTENDED_NTZ_CONSOLIDATION_BREAKOUT` identity opts out; `EQUIVALENT_CANDLE_REVERSAL` keeps its separate opposite-extreme stop.

**Why:** The direct consolidation taxonomy is shared by multiple strategies, so changing the broad helper without an identity gate silently changes unrelated stops.

**How to apply:** Reuse the versioned midpoint helper for candidate execution, replay/audit projection, and Visual Review, and fail closed when the frozen direct and guard ranges disagree.