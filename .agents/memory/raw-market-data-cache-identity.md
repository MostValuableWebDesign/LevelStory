---
name: Raw market-data cache identity
description: Durable boundary between reusable historical market data and strategy-specific replay results.
---

Raw market-data reuse must be identified by the persisted source fingerprint, contract, requested coverage and timeframes, session-calendar identity, schema version, and normalization version. Strategy, formula, risk, and execution rules belong to result caches, not the raw-data cache.

**Why:** Changing a strategy should not cause historical candles and their provenance to be imported or materialized again, while replacing the underlying source must not reuse stale data.

**How to apply:** Keep the persistent historical SQLite store authoritative, invalidate affected in-memory entries when source or catalog provenance changes, and expose incomplete/tick-verification state rather than upgrading partial candle data to verified intrabar evidence.