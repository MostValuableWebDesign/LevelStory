---
name: Interval-scoped intrabar coverage
description: Verified ordered evidence authorizes only the candle interval whose contract and coverage metadata were validated.
---

Exact chronology is interval-scoped: coverage for an entry candle must not authorize later execution candles, and a later covered interval must not authorize an uncovered one. Points outside the declared interval are ignored; malformed, out-of-order, wrong-contract, or contradictory points inside it invalidate that interval and restore conservative OHLC behavior.

**Why:** A single dataset-level completeness flag can over-authorize sparse later evidence and turn an OHLC barrier ambiguity into a fabricated exact event.

**How to apply:** Carry interval coverage through replay and batch boundaries, validate each candle against its own interval before using ordered points, and preserve null exact timestamps whenever that candle lacks verified chronology.