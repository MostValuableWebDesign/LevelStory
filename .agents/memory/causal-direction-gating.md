---
name: Causal direction gating
description: Governs when patience qualification may bypass or must honor the 15-minute trend.
---

Causal ORB, consolidation-breakout, and equivalent-reversal directions are authoritative for patience qualification; generic patience continuation remains gated by a confirmed matching 15-minute trend.

**Why:** A universal trend gate prevented causal ORB/reversal evidence from producing patience shapes and made the historical funnel appear empty even when level interactions and immediate P→E sequences existed.

**How to apply:** Carry an explicit direction source and ORB trend epoch through patience analysis and audit evidence. A completed buffered close establishes or reverses the epoch, but the new direction is eligible only from the following candle; invalidate only pending old-direction arms, not already confirmed positions.

Each ORB epoch must also own its executable breakout and pullback context. When replay reaches a later candle after a reversal, scope patience occurrences to the epoch ID so same-direction epochs cannot merge; use prior-epoch analyses to retain real expiration IDs for pending arms and candidates.

**Why:** Reusing the first breakout after a reversal left the new direction blocked by stale evidence, while direction-only filtering could merge separated epochs and lose the audit trail for invalidated pending work.

**How to apply:** Build fresh epoch breakout context from the confirming transition, make it effective on the next candle, and pass the epoch identity through pullback, Phase 5, candidate, and historical transition projection.

Epoch breakout quality metrics must be derived from completed candles at or before the confirming close; active-position arbitration must compare entry and effective-exit timestamps in the same candle-time domain.

**Why:** Contract-local replay indexes are not comparable with the global replay cursor across scheduled rollovers, and future candles can otherwise leak into epoch quality or continuation qualification.

**How to apply:** Filter causal metric inputs by confirmation time and use an exclusive effective-exit boundary; clear the timestamp state when the scheduled contract changes.