---
name: Historical index startup race
description: Historical visual-review generation can race the first committed-index load after a restored archive becomes available.
---

After a workspace restore or API restart, the committed SQLite index may already exist while the process has not yet loaded its manifest. A first historical visual-review worker can therefore report that the ready index is missing; loading historical-data status before retrying establishes the process-local ready state without rebuilding the archive.

**Why:** The persisted archive is authoritative, but readiness is initialized lazily in the running API process. The worker must not be treated as evidence that the committed SQLite file is absent until the parent has attempted its read-only committed-index load.

**How to apply:** On this failure, request the historical-data status once, confirm `state: ready` and the expected contract/file counts, then retry the same review generation. Do not rebuild or promote a workspace cache snapshot.