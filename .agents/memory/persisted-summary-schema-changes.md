---
name: Persisted summary schema changes
description: Safe cache behavior when persisted historical summaries gain new response metadata
---

When a persisted historical index summary gains new fields, its cache/importer version must change and persisted values must be structurally validated before reuse.

**Why:** A warm cache can have the same source identity while predating the response shape, causing the API or UI to dereference missing metadata instead of rebuilding safely.

**How to apply:** Treat response-shape changes as cache-schema changes: invalidate old persisted summaries, validate required reconciliation metadata on read, and fail closed with an explicit error if validation fails.