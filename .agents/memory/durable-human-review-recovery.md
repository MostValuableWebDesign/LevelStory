---
name: Durable human review recovery
description: The persistence boundary for reviewer judgments and recovery of their ephemeral visual-validation set.
---

Reviewer judgments are reviewer-scoped, revision-checked, idempotent database records. The first durable review for a set also stores the serialized set payload; an authenticated read can reconstruct that exact set ID after process loss, then overlay that reviewer’s latest reviews. The in-memory cache may evict reviewed sets, so durable restoration cannot depend on keeping reviewed entries resident.

**Why:** Visual-validation sets are otherwise process-local. Persisting only the judgment would leave the browser’s review-set ID unrecoverable after restart, while sharing one reviewer’s judgment with another would violate identity isolation.

**How to apply:** Keep review writes transactional with structured teaching evidence, use the visible revision for optimistic concurrency, hydrate only the authenticated reviewer’s rows before returning a set, and let TTL/LRU pruning evict reviewed sets normally.