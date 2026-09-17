---
name: Direct crossing identity
description: Causal identity requirements for direct consolidation entries across replay cursors and projections
---

Direct consolidation evidence must preserve the frozen range, its constituent candle identity, the arm/qualification timestamp, and the physical crossing candle separately from the replay evaluation cursor. A completed-bar same-candle entry uses the crossing candle itself; an unverified OHLCV replay must not invent an intrabar crossing timestamp.

**Why:** Direct setup evaluation can rediscover an earlier qualified range while a later cursor is being audited. Using that later cursor as the signal silently changes the physical occurrence and can create stale or duplicate candidates.

**How to apply:** Carry the identity through the public snapshot, audit, occurrence, candidate causal identity, and modeled trade. Include the identity in governed formula/cache provenance whenever the contract changes.