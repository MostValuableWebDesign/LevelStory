---
name: Visual replay timeout fallback
description: Safe behavior when historical Visual Review generation exceeds the worker deadline.
---

Historical Visual Review generation may publish a partial job only when a completed result for the exact same deterministic request is available. That result remains visible with a timeout warning; a timeout without a same-request result stays an explicit failure.

**Why:** The worker currently emits one final set rather than a stream of candidate snapshots. Treating progress or unrelated cached data as a current partial result could expose incomplete or mismatched historical evidence.

**How to apply:** Keep the timeout state distinct from successful completion, preserve the prior result’s identity and cache metadata, and make the UI render the retained set with a clear warning. Add true current-run partial snapshots only with causal cursors and an explicit partial-result contract.