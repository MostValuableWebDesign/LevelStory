---
name: Reconciliation fixture boundary
description: Preserve lightweight metric fixtures while enforcing strict projection invariants for populated confirmed-signal collections.
---

Reconciliation may accept legacy metric-only fixtures only when explicitly marked synthetic; production reports with missing partition or audit evidence must clear authoritative candidates/trades and fail closed.

**Why:** Existing Phase 3 metric tests intentionally omit raw occurrence evidence, but inferring fixture status from missing data lets malformed historical reports retain stale authoritative results.

**How to apply:** Require an explicit synthetic marker for compatibility; emit deterministic missing-evidence reason codes and zero candidate-derived metrics otherwise. Keep populated-signal XOR, ownership, and disposition-total invariants strict.