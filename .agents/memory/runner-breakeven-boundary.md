---
name: Runner breakeven boundary
description: Timing and audit semantics for deferred runner breakeven after a target or 1R checkpoint.
---

A target or +1R candle may create runner-breakeven pending state, but it must never qualify the runner on that same candle. Qualification requires a later completed candle with a favorable close; the tightened entry stop is effective from the next candle, and a pre-existing tighter trailing stop must not be widened.

**Why:** Same-candle qualification lets the checkpoint candle's close change the stop before the runner has had a complete post-checkpoint observation, producing optimistic historical exits and ambiguous audit timing.

**How to apply:** Keep the pending candle identity/timestamp, qualification timestamp, effective-from timestamp, prior stop, resulting stop, and whether tightening was actually applied together in execution audit and replay projections.