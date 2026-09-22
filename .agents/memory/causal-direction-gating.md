---
name: Causal direction gating
description: Governs when patience qualification may bypass or must honor the 15-minute trend.
---

Causal ORB, consolidation-breakout, and equivalent-reversal directions are authoritative for patience qualification; generic patience continuation remains gated by a confirmed matching 15-minute trend. Direct consolidation breakout qualification must have an independently established direction at the setup candle; never infer authorization from the threshold crossing or the current evaluation trend.

**Why:** A universal trend gate prevented causal ORB/reversal evidence from producing patience shapes and made the historical funnel appear empty even when level interactions and immediate P→E sequences existed. The opposite failure—letting a crossing choose its own direction—qualifies a setup without causal authorization and can let future/current trend state leak backward.

**How to apply:** Carry an explicit direction source and ORB trend epoch through patience analysis, direct setup evidence, audit, occurrence, candidate, and execution. A completed buffered close establishes or reverses the epoch, but the new direction is eligible only from the following candle; invalidate only pending old-direction arms, not already confirmed positions.

Each ORB epoch must also own its executable breakout and pullback context. When replay reaches a later candle after a reversal, scope patience occurrences to the epoch ID so same-direction epochs cannot merge; use prior-epoch analyses to retain real expiration IDs for pending arms and candidates.

**Why:** Reusing the first breakout after a reversal left the new direction blocked by stale evidence, while direction-only filtering could merge separated epochs and lose the audit trail for invalidated pending work.

**How to apply:** Build fresh epoch breakout context from the confirming transition, make it effective on the next candle, and pass the epoch identity through pullback, Phase 5, candidate, and historical transition projection.

Epoch breakout quality metrics must be derived from completed candles at or before the confirming close; active-position arbitration must compare entry and effective-exit timestamps in the same candle-time domain.

**Why:** Contract-local replay indexes are not comparable with the global replay cursor across scheduled rollovers, and future candles can otherwise leak into epoch quality or continuation qualification.

**How to apply:** Filter causal metric inputs by confirmation time and use an exclusive effective-exit boundary; clear the timestamp state when the scheduled contract changes.

For reversal strategies, the executable direction and profit target must oppose the confirmed trend. A short target in a confirmed bearish trend, or a long target in a confirmed bullish trend, is continuation evidence and cannot be labeled as a reversal.

**Why:** A visual-review candidate was labeled Peak Retracement Reversal even though its target followed the active trend; reversal attribution must describe counter-trend intent, not merely a Fibonacci-derived direction.

**How to apply:** Require the counter-trend predicate before `PEAK_RETRACEMENT_REVERSAL` can qualify. Keep the v23 removal of the mandatory retracement-percentage threshold; counter-trend direction is an independent semantic gate.

Continuation authorization must validate the exact occurrence identity and immutable source timestamp, not only the current direction label. Breakout-backed occurrences must match a detected, non-failed executable breakout state; ORB-trend occurrences must match one effective epoch and its completed confirming transition.

**Why:** A current cursor direction can remain plausible after the causal occurrence has been superseded, failed, or moved to another ORB epoch. Without source-time binding, both evaluators can qualify a stale P→E sequence.

**How to apply:** Reuse one validator for ORB Pullback and Patience Continuation, fail closed on missing or conflicting provenance, and version every result/cache surface when this contract changes.