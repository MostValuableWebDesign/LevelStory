---
name: Exact edge predicate mapping
description: Constraint for deriving Phase 3 edge predicates from persisted audit evidence
---

Phase 3 edge predicates must parse the exact persisted Phase 6 rule key or explicitly aggregate the exact keys assigned to each requirement. Do not use broad or overlapping prose searches.

**Why:** Reversal and consolidation audits contain several related rule details; substring matching can cause one requirement’s evidence to satisfy another or miss a governed stability rule.

**How to apply:** Maintain an explicit predicate-to-rule-key mapping, aggregate multiple keys only when the contract says the predicate requires all of them, and return `EVIDENCE_UNAVAILABLE` when evidence is absent. Keep timestamp predicates separate.