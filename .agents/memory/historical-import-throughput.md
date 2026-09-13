---
name: Historical import throughput
description: Large historical imports need bounded parser batches and staging-specific SQLite durability settings to finish in a practical time.
---

Large index builds keep the parser bounded with larger batches, load existing candle rows once per batch for conflict checks, and use normal synchronous mode only on the temporary staging database. The committed index remains fully synchronous and is still installed atomically.

**Why:** Five-year source files make per-candle SQLite lookups and an fsync for every staging transaction impractical, while atomic replacement and verified checkpoints still protect the committed library.

**How to apply:** Preserve the staging checkpoint and source-fingerprint checks when tuning throughput; do not apply staging pragmas to the committed database.