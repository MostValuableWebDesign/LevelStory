---
name: Historical cancellation recovery
description: Import cancellation exposes resumable state only after worker cleanup and distinguishes checkpoint resume from safe restart.
---

Historical imports remain in `cancelling` until the controller, running-job ownership, parser transaction, and staging preservation are settled. A verified checkpoint becomes `cancelled_resumable`; cancellation before a checkpoint becomes `cancelled_restartable` and reuses validated materialized sources.

**Why:** Publishing resumable state before ownership cleanup can let Resume queue a job while the old worker still owns it, and pre-staging cancellation has no checkpoint to resume.

**How to apply:** Keep Resume unavailable during `cancelling`, validate checkpoint fingerprints before checkpoint resume, and clear staging/checkpoint metadata when starting a safe restart.