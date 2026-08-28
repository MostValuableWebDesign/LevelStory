---
name: Replay audit cadence
description: The distinction between evaluating every candle and allowing overlapping historical entries.
---

Every completed regular-session candle must remain visible in causal audit evidence. An active simulated position may reject a new overlapping entry, but it must not suppress the candle's setup evaluation or audit record.

**Why:** Skipping candles during an open trade made hourly-style sampling reappear unintentionally and obscured the exact reason an entry was not opened.

**How to apply:** Keep position-overlap prevention as an explicit rejection such as `POSITION_ACTIVE`; do not use it as a loop-level filter before the snapshot and audit are produced.