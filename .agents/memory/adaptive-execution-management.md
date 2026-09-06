---
name: Execution management
description: Causal management rules for candidate-owned MES Shadow execution.
---

Candidate-owned execution freezes the patience candle extreme with a fixed eight-MES-tick strategy-stop buffer and fixed contract quantity at candidate creation. Structural R uses that frozen stop only; account balance, risk percentage, compounding, and catastrophe protection must not reject a candidate for stop distance.

**Why:** Management changes must not leak future candles or let legacy account-sizing and catastrophe-stop paths silently change candidate outcomes.

**How to apply:** Preserve the 1–2 tick target buffer, fixed eight-tick strategy stop, ATR-derived runner buffer, six-candle progress evaluation, and one-/two-contract modes when extending replay or Visual Review. Insufficient target reward-to-risk remains a separate target-plan rejection.