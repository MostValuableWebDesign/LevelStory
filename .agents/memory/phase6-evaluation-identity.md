---
name: Phase 6 evaluation identity
description: Preserve independent strategy evaluator identities through snapshot serialization before canonical occurrence projection.
---

Canonical ownership and evaluator identity are separate concerns: a Patience Candle Continuation evaluation may be owned by the canonical ORB Pullback candidate while still needing its own setup type in the serialized Phase 6 evaluations.

**Why:** Canonicalizing Patience to ORB Pullback at the snapshot boundary removed the evaluator before authoritative audit construction, so matched edges and secondary strategy provenance disappeared even though Phase 6 had qualified it.

**How to apply:** Keep exact evaluator setup types in production snapshots and use `primarySetup`, `primaryEdge`, and taxonomy resolution for physical candidate ownership and deduplication.