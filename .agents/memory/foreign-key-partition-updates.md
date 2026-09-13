---
name: SQLite partition updates with child candles
description: Foreign-key-safe persistence rule for candle partition metadata
---

Never use `INSERT OR REPLACE` to update a candle partition row while foreign keys and `ON DELETE CASCADE` are enabled. SQLite implements replace as delete plus insert, which removes the child candle rows and leaves misleading partition counts.

**Why:** A bulk-import reconciliation failure showed that partition metadata could survive while every associated candle row had been cascaded away.

**How to apply:** Use an in-place `ON CONFLICT DO UPDATE` for existing partition rows, and validate both partition counts and aggregate counts after any persistence optimization.