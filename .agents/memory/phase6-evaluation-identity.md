---
name: Phase 6 evaluation identity
description: Preserve independent strategy evaluator identities through snapshot serialization before canonical occurrence projection.
---

Canonical ownership and evaluator identity are separate concerns: a Patience Candle Continuation evaluation may be owned by the canonical ORB Pullback candidate while still needing its own setup type in the serialized Phase 6 evaluations. Independent strategy switches must be applied to the raw evaluator before canonical projection.

**Why:** Canonicalizing Patience to ORB Pullback at the snapshot boundary removed the evaluator before authoritative audit construction, so matched edges and secondary strategy provenance disappeared even though Phase 6 had qualified it. Re-adding canonical ORB as a matched edge when only Patience is enabled creates false disabled-strategy evidence.

**How to apply:** Keep exact evaluator setup types in production snapshots; filter with raw setup types; use `primarySetup`, `primaryEdge`, and taxonomy resolution for physical candidate ownership and deduplication. A Patience-only occurrence may retain ORB ownership but must list only Patience in `matchedEdges`.