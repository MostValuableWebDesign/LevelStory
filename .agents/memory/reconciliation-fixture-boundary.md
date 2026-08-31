---
name: Reconciliation fixture boundary
description: Preserve lightweight metric fixtures while enforcing strict projection invariants for populated confirmed-signal collections.
---

Reconciliation may accept legacy metric-only fixtures that contain candidates but no raw confirmed occurrences; once confirmed occurrences are present, candidate/rejection XOR, ownership, and disposition-total invariants must be strict.

**Why:** Existing Phase 3 metric tests intentionally omit raw occurrence evidence, while production reports must fail closed rather than hide unexplained confirmed signals.

**How to apply:** Keep the fixture boundary explicit in reconciliation code and ensure any new invariant regression includes at least one confirmed occurrence when testing populated-signal behavior.