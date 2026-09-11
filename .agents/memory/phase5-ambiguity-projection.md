---
name: Phase 5 ambiguity projection
description: Preserve same-candle ORB reversal ambiguity through top-level patience analysis.
---

When an occurrence is classified as `AMBIGUOUS_EVENT_ORDER`, the top-level Phase 5 result must reuse that occurrence and return the same non-executable state. It must not fall back to a generic threshold-reaching candidate and expose `ENTRY_TRIGGERED`.

**Why:** A completed E candle can reach the prior-direction threshold intrabar while also closing beyond the opposite ORB boundary. Five-minute OHLC cannot establish which event happened first, so treating the generic threshold as authoritative creates a false executable signal.

**How to apply:** Keep ambiguity-aware occurrence selection ahead of generic candidate fallback, and preserve the occurrence's reason and null trigger price in the public analysis.