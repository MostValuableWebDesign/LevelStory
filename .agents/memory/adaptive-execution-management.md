---
name: Adaptive execution management
description: Causal ATR-frozen management rules for candidate-owned MES Shadow execution.
---

Candidate-owned execution freezes causal ATR-derived buffers and fixed contract quantity at candidate creation. Structural R uses the frozen strategy stop only; account balance, risk percentage, compounding, and catastrophe protection must not alter quantity or structural target distance.

**Why:** Management changes must not leak future candles or let legacy account-sizing and catastrophe-stop paths silently change candidate outcomes.

**How to apply:** Preserve the 14-completed-candle ATR snapshot, 1–2 tick target buffer, 4–8 tick stop/runner buffers, six-candle progress evaluation, and one-/two-contract modes when extending replay or Visual Review.