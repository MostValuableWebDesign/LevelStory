---
name: Universal target breakeven
description: The shared nine-tick target-trade breakeven trigger and its causal activation boundary.
---

Every target-bound strategy uses a nine-MES-tick favorable excursion trigger, including when an eligible key-level target or an exactly-1R fallback target remains active. The trigger candle only creates pending state; the entry-price stop becomes effective on the following candle, with adverse-first OHLCV handling. The legacy completed-bar rule remains only for no-target management without a target trigger.

**Why:** Target trades previously received this behavior only when their edge was Strong Breakout, while other strategies used no-target timing or no breakeven at all. Same-candle stop activation would also use information unavailable at the entry candle boundary and create optimistic replay exits.

**How to apply:** Keep the governed trigger in shared strategy configuration, pass it whenever a target price exists through candidate-owned historical execution and Shadow Account Replay, preserve measured excursion and trigger/activation labels in audit evidence, and keep no-target bar management separate.