---
name: Historical index startup race
description: Historical visual-review generation can race the first committed-index load after a restored archive becomes available.
---

After a workspace restore or API restart, the committed SQLite index may already exist while the process has not yet loaded its manifest. A first historical visual-review worker can therefore report that the ready index is missing; load the committed manifest read-only in both parent and worker, with a SQLite lock wait, before retrying. Do not open the large committed archive through the normal write/DDL initialization path from a worker.

**Why:** The persisted archive is authoritative, but readiness is initialized lazily in the running API process. A worker-side write-capable SQLite open can contend with the parent connection and falsely surface “ready index not found,” even when status polling reports ready.

**How to apply:** Use a read-only committed-index accessor for replay workers, configure a bounded SQLite busy timeout, and retry the same review generation after readiness is confirmed. Do not rebuild or promote a workspace cache snapshot.