---
name: Causal pullback lifecycle
description: Pullback duration limits are diagnostics, not eligibility gates.
---

After a completed breakout, a pullback remains causally eligible beyond configured candle and minute diagnostics until a real lifecycle boundary occurs, such as session/date/contract change or the exclusive entry cutoff.

**Why:** Fixed duration expiry discarded valid later-morning pullbacks even though Phase 5 already owns immediate P→E confirmation and rearming semantics.

**How to apply:** Keep old duration values in replay evidence for comparison, but do not use them to truncate pullback candles or change an otherwise valid pullback to expired. Treat same-direction continuation before the first countertrend interaction as part of the original breakout; only a later completed same-direction breakout can supersede the arm.