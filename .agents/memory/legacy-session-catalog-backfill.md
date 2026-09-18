---
name: Legacy session catalog backfill
description: Compatibility constraint for SQLite historical indexes created before the persistent session catalog.
---

Pre-catalog committed indexes may contain valid candle partitions and manifests without session-catalog rows. They need an explicit atomic backfill or reindex before catalog-only date selection can be authoritative; routine status polling must not rediscover or rehash source directories.

**Why:** The session catalog is now the intended date-selection authority, but silently deriving missing rows from source files would reintroduce the repeated discovery and hashing cost this work removes.

**How to apply:** Treat absent catalog rows as an explicit initialization/backfill state. Any migration must derive only from committed index/manifests or a deliberate source-backed reindex, publish atomically, and preserve the distinction between missing data, incomplete coverage, and unavailable catalog metadata.