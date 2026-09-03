---
name: Candidate causal identity
description: Provenance requirements for candidate-owned fills and management evidence
---

Candidate-owned execution artifacts must retain one shared causal identity containing the confirmed signal occurrence, eligibility arm, and active consolidation zone when present. The same identity must remain attached through candidate creation, modeled fill, stop evidence, and target evidence.

**Why:** Reconciliation and human review must be able to prove that execution and management belong to the exact causal P→E signal rather than a nearby arm, zone, or legacy modeled trade.

**How to apply:** When adding or changing candidate projection, execution, stop, target, or Visual Review evidence, preserve the shared identity and add an explicit invariant test for every new propagation path.