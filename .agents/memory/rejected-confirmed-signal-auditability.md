---
name: Rejected confirmed signal auditability
description: Projection behavior for canonical confirmed occurrences with invalid identity evidence.
---

Canonical confirmed occurrences with required P/E fields must remain in the candidate-projection input even when identity invariants fail.

**Why:** Filtering them before the projection loop loses the rejection diagnostic and makes invalid confirmed signals appear silently absent.

**How to apply:** Reject them inside the loop with `INVALID_CAUSAL_IDENTITY` and exact invariant details; preserve the ledger occurrence, create no candidate, and create no trade.