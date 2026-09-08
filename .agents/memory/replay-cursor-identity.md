---
name: Replay cursor identity
description: Stable historical occurrence identity when an audit cursor may contain an incomplete E candle
---

Historical audit cursors for one causal P→E occurrence can disagree about whether the expected E candle is complete. Their identity must use the expected E boundary (open plus the governed candle duration), not the observed E close or a null close from a partial cursor.

**Why:** Using observed completion evidence split partial and complete cursors into separate ledger rows, allowing an earlier incomplete snapshot to remain authoritative and hide a later confirmed signal.

**How to apply:** Keep completion status, entry evidence, and target snapshots mergeable metadata; reserve identity fields for the causal occurrence and expected candle boundaries.