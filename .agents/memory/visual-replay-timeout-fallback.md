---
name: Visual replay timeout fallback
description: Safe behavior when historical Visual Review generation exceeds the worker deadline.
---

Historical Visual Review generation may publish a partial job when the worker has emitted validated snapshots for the same deterministic request, or when a completed result for that exact request is available. The partial result remains visible with a timeout warning; a timeout without either safe source stays an explicit failure.

**Why:** Progress counters alone are not review evidence. Partial snapshots must come from the worker's causal replay and must not be replaced with unrelated cached data.

**How to apply:** Keep timeout state distinct from successful completion, store worker-emitted partial sets privately rather than publishing them as the latest complete cache, preserve the review-set identity for review actions, and make the UI render the retained set with a clear warning.