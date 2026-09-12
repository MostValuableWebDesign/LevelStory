---
name: Historical import checkpoints
description: Durable resume boundaries and maintenance validation for historical MES imports
---

Historical imports should checkpoint only verified file/contract boundaries, cumulative counts, completed partitions, source fingerprint, and staging path. A restart may reuse a staging SQLite index only after matching the source fingerprint; compressed inputs resume at the next incomplete file boundary rather than guessing a byte offset.

**Why:** compressed streams do not provide a generally safe byte-level resume point, while a durable completed-boundary record lets a process restart avoid reparsing already indexed sources without risking a partial commit.

**How to apply:** keep the ready index untouched until staging reconciliation succeeds. Routine status checks must remain metadata-only; source hashing, SQLite integrity checks, and full partition reconciliation belong behind an explicit maintenance operation.