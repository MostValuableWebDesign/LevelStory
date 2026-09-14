---
name: Durable human review recovery
description: The persistence boundary for reviewer judgments and recovery of their ephemeral visual-validation set.
---

Reviewer judgments are reviewer-scoped, revision-checked, idempotent database records. The first durable review for a set also stores the serialized set payload; an authenticated read can reconstruct that exact set ID after process loss, then overlay that reviewer’s latest reviews.

**Why:** Visual-validation sets are otherwise process-local. Persisting only the judgment would leave the browser’s review-set ID unrecoverable after restart, while sharing one reviewer’s judgment with another would violate identity isolation.

**How to apply:** Keep review writes transactional with structured teaching evidence, use the visible revision for optimistic concurrency, and hydrate only the authenticated reviewer’s rows before returning a set.