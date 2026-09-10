---
name: Rejected confirmed signal auditability
description: Projection behavior for canonical confirmed occurrences with invalid identity evidence.
---

Canonical confirmed occurrences with required P/E fields must remain in the candidate-projection input even when identity invariants fail.

**Why:** Filtering them before the projection loop loses the rejection diagnostic and makes invalid confirmed signals appear silently absent.

**How to apply:** Reject them inside the loop with `INVALID_CAUSAL_IDENTITY` and exact invariant details; preserve the ledger occurrence, create no candidate, and create no trade.

Strategy attribution has a separate gate: a confirmed physical P→E sequence does not qualify every setup audit that observed it. Only a `SETUP QUALIFIED` edge, or a same-cursor qualified secondary edge, may become canonical strategy attribution; failed edges remain diagnostic and are rejected with an explicit no-qualified-edge reason.

**Why:** A failed Strong Breakout audit was being promoted by edge precedence over a confirmed patience sequence, producing an executable trade and Visual Review label despite every Strong Breakout rule failing.

**How to apply:** Keep the physical occurrence in the ledger for auditability, but mark its edge qualification explicitly, exclude failed edges from matched/primary attribution, and block candidate execution until at least one evaluated edge is qualified.