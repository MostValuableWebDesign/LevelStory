---
name: Historical replay performance
description: Performance constraint for long, DST-aware historical replays
---

Large imported backtests can become CPU-bound when every candle repeatedly constructs the same New York session boundaries through `Intl`. Reuse stable contract calendars, memoize bounded trading-date conversions, and cache session windows before optimizing replay fidelity.

**Why:** Historical ranges repeatedly classify thousands of candles at many causal checkpoints, while the session boundaries are immutable for a given calendar and date.

**How to apply:** Preserve the existing `America/New_York` conversion and causal checkpoints, but reuse calendar-scoped session-window results and bounded timestamp conversions rather than replacing DST-safe logic with a fixed UTC offset.