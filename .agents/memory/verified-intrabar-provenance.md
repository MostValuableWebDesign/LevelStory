---
name: Verified intrabar provenance
description: Exact intrabar chronology requires validated source metadata in addition to a completeness flag.
---

Exact intrabar execution is authoritative only when the dataset carries validated tick provenance: matching contract identity, finite coverage bounds spanning the candidate candle, finite ordered points, and explicit equal-timestamp conservative semantics. Historical OHLCV and one-minute adapters remain conservative fallback sources.

**Why:** A non-empty or sparsely populated point array can omit the entry crossing or a competing barrier and falsely turn an OHLC ambiguity into a certain fill or exit.

**How to apply:** Keep the completeness flag and metadata together through batch partitions, require the metadata at Phase 9 boundaries, and emit null exact crossing/exit timestamps when the source cannot prove chronology.