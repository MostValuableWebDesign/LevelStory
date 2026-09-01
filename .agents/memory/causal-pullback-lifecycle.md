---
name: Causal pullback lifecycle
description: One causal pullback can support later patience candidates until a real lifecycle boundary.
---

After a completed breakout, one causal pullback arm remains eligible for every later valid patience candle until a real lifecycle boundary occurs, such as session/date/contract change, an opposite-direction breakout, or the exclusive entry cutoff. A later same-direction breakout is another opportunity and must not terminate or erase the earlier arm; a separate arm may be evaluated alongside it. A confirmed or invalid P→E attempt is occurrence-level evidence and does not consume or invalidate the pullback arm. In particular, an inside-NTZ or wrong-side patience failure is not an arm-level structural boundary; only an explicit terminal arm state from the causal pullback lifecycle may terminate it.

**Why:** A pullback happens once; requiring a second pullback for a later patience candle, or consuming the arm after the first confirmation, discards valid later P→E candidates.

**How to apply:** Keep duration values in replay evidence, but do not use them to truncate a valid arm. Keep Phase 5 arm state active after confirmed and failed P→E attempts; allow the lifecycle reducer to re-arm the confirmation portion without opening a second pullback. Treat legacy CONSUMED markers as confirmation provenance, not candidate gates. Only explicit session, contract, data-gap, cutoff, arm-level structural, or opposite-breakout boundaries terminate the arm. Preserve later same-direction opportunities without converting them into a terminal state.