---
name: Governed replay pinning
description: Historical Visual Review generation must retain one exact strategy identity and configuration for its full lifecycle.
---

Resolve the active strategy once at generation start and pass that immutable pin through cache identity, worker replay, snapshots, and persisted provenance.

**Why:** activation can occur while a replay is queued or running; reading the active strategy again would make one review set internally inconsistent and make old results change retroactively.

**How to apply:** treat the pin as server-owned request metadata, include version/config identity in cache keys, and never let worker code resolve the current active version for an already-started job.