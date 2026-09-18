---
name: Node SQLite constructor options
description: Node's DatabaseSync constructor rejects an undefined options argument in this workspace.
---

Always pass an options object when constructing `DatabaseSync`, including the writable case; use `{ timeout: 30_000 }` rather than `undefined`.

**Why:** The historical index status path failed after restart because the Node runtime requires the second constructor argument to be an object, even when no read-only flag is needed.

**How to apply:** Preserve an explicit options object in every SQLite store constructor and include read-only or timeout settings there.