---
name: Session analysis persistence boundary
description: Persisted session results must stay compact because raw replay arrays can exceed the database driver's query construction limit.
---

Persisted session-analysis rows should contain report evidence and compact dataset metadata, not raw candle, tick, or one-minute arrays; oversized compact reports should remain valid in-process results without being persisted.

**Why:** The full replay result is needed by the current request, but storing partition market history in the JSONB cache can trigger a driver-side `Invalid string length` failure and make Visual Review generation fail.

**How to apply:** Keep persistence optional and bounded. Strip replay arrays before cache writes, validate the serialized payload size, and return the computed report even when it is not cacheable.