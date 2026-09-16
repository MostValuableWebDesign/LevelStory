---
name: Ordered intrabar completeness
description: Rules for using timestamped tick evidence to resolve OHLC execution barriers.
---

Complete ordered evidence may select the first timestamped executable event before any candle-level stop-first fallback. A non-empty tick list is not proof of complete coverage; incomplete evidence must preserve conservative OHLC behavior, and competing events at the same timestamp remain ambiguous/adverse-first.

**Why:** Sparse or partially captured ticks can show a favorable crossing while omitting an earlier adverse crossing, and equal timestamps do not establish order. Treating either as definitive changes fills and account-position boundaries.

**How to apply:** Require an explicit source-coverage assertion at the replay boundary, carry exact event timestamps separately from candle observation timestamps, and test target-first, stop-first, entry-candle, partial-runner, and equal-time cases in both directions.