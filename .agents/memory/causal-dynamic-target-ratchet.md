---
name: Causal dynamic target ratchet
description: Sequencing and monotonicity rules for VWAP and EMA 200 executable target updates.
---

Indicator-derived target proposals are evidence from a completed candle, not retroactive fills. Evaluate the candle against the target effective at its open, process stop/target outcomes first, then calculate the indicator through that close; an accepted result becomes effective from the following candle.

**Why:** Applying the close-derived target to the same candle can manufacture a fill using information unavailable at that candle's open.

**How to apply:** Keep structural targets frozen, place dynamic targets eight MES ticks on the near side, accept only a closer result that does not cross the modeled entry, and retain ignored proposals in the immutable update ledger.