---
name: Strong Breakout breakeven
description: The strategy-specific nine-tick breakeven trigger and its causal activation boundary.
---

Strong Breakout After Consolidation uses a nine-MES-tick favorable excursion trigger even when an eligible key-level target remains active. The trigger candle only creates pending state; the entry-price stop becomes effective on the following candle, with adverse-first OHLCV handling.

**Why:** This strategy needs earlier loss protection than the no-forward-level six-bar rule, but same-candle stop activation would use information unavailable at the entry candle boundary and create optimistic replay exits.

**How to apply:** Keep the governed trigger in strategy configuration, pass it through candidate-owned historical execution and Shadow Account Replay, preserve the trigger/activation labels in audit evidence, and do not apply it to unrelated strategies.