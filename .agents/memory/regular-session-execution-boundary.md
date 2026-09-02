---
name: Regular-session execution boundary
description: Candidate-owned historical stops must use the same regular-session candle window shown by Visual Review.
---

Candidate-owned execution must restrict post-entry barrier evaluation to completed candles inside the contract's regular trading window. Do not scan the full contract timeline and then show only regular-session candles in Visual Review.

**Why:** An overnight candle can falsely trigger a strategy stop after the chart's review window has ended, producing an exit timestamp and price that cannot be inspected in the displayed evidence.

**How to apply:** Derive the contract calendar and regular window before building post-entry execution candles; retain the final regular candle as the session-close fallback.