---
name: Tolerant chart evidence parsing
description: Vision extraction must preserve unknown evidence without inventing authoritative prices or candles.
---

Unknown optional chart metadata should default to conservative unknown values and flow into the existing insufficient-evidence evaluator. Malformed candle or level records must be discarded or invalidate that evidence, never be filled with synthetic OHLC or price values.

**Why:** Vision models may omit fields when an axis, volume pane, or timestamp is not visible. Rejecting the entire response hides a valid “insufficient evidence” outcome, while defaulting numeric evidence could create a false candidate.

**How to apply:** Keep calibration, direction, indexes, activation, exits, and confidence conservative when absent; keep candle/level numeric fields strict; log validation details without storing raw image/model payloads.