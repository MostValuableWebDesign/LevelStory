---
name: Historical index load concurrency
description: Runtime constraint for loading the persisted multi-contract historical index.
---

The persisted multi-contract historical index is large enough that overlapping JSON reads and parses can fail with `Invalid string length`, even when the requested date window is valid.

**Why:** Visual Review can have an initial GET and a user-triggered POST in flight together, and each request previously attempted to parse the same large cache independently.

**How to apply:** Keep a shared in-flight promise around ready-index loading, return it to concurrent callers, and only clear the promise after the read completes. Do not rebuild the index as a workaround.