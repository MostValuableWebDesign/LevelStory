---
name: Historical import batching
description: Generic Databento files must be demultiplexed once with contract/date-scoped diagnostics and metadata-only status polling.
---

Generic historical files must be parsed in one streaming pass, with independent ordering, deduplication, coverage, and aggregation state for each outright MES symbol. Identical duplicates are non-fatal; conflicting or malformed rows only invalidate the affected contract/date. Ordinary status polling must read committed metadata without rediscovering or rehashing source files.

**Why:** Re-reading a large generic file once per symbol multiplied CPU and memory, while global rejection and duplicate counters incorrectly invalidated otherwise usable dates. Status polling also caused expensive source work and rate-limit bursts.

**How to apply:** Keep generic batch parsing contract-local and feed persisted batches/partitions into indexing. Reserve full source hashing for explicit imports and startup integrity validation.