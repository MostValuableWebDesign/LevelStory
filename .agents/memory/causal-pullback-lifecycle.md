---
name: Causal pullback lifecycle
description: One causal pullback can support later patience candidates until a real lifecycle boundary.
---

After a completed breakout, one causal pullback arm remains eligible for every later valid patience candle until a real lifecycle boundary occurs, such as session/date/contract change, a newer completed breakout, or the exclusive entry cutoff. A confirmed or invalid P→E attempt is occurrence-level evidence and does not consume or invalidate the pullback arm.

**Why:** A pullback happens once; requiring a second pullback for a later patience candle, or consuming the arm after the first confirmation, discards valid later P→E candidates.

**How to apply:** Keep duration values in replay evidence, but do not use them to truncate a valid arm. Keep Phase 5 arm state active after confirmed and failed P→E attempts; allow the lifecycle reducer to re-arm the confirmation portion without opening a second pullback. Treat legacy CONSUMED markers as confirmation provenance, not candidate gates. Only true session, contract, data-gap, cutoff, structural, opposite-breakout, or superseding-breakout boundaries terminate the arm.