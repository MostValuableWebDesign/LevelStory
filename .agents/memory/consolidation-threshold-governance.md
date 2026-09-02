---
name: Consolidation threshold governance
description: Rules for preserving governed Phase 6 consolidation threshold provenance and cache identity.
---

The active Phase 6 consolidation threshold configuration is part of the strategy formula identity, and its version plus exact values must remain visible on both audit records and immutable historical occurrence rows.

**Why:** A default-only fingerprint can reuse results produced under a different active governed configuration, while ledger consumers cannot verify the rule that produced an occurrence if provenance exists only on the parent audit row.

**How to apply:** When changing any governed consolidation threshold or its version, update the typed configuration, diagnostic evidence, formula/cache identity, audit schema, occurrence schema, and deterministic boundary tests together. Keep the 24-tick maximum explicitly labeled as an unvalidated trading assumption unless independent evidence changes that status.

Consolidation width is governed adaptively against the median true range of the preceding completed five-minute candles, with overlap, repeated edge rejection, bounded directional progression, and expansion controls. The legacy tick cap is diagnostic evidence only and cannot independently reject a zone.

**Why:** A fixed MES-tick ceiling does not scale across volatility regimes and can reject structurally valid consolidations; causal preceding-candle evidence avoids using future information.

**How to apply:** Keep the same adaptive metrics and completed-candle boundary in Phase 6 and Visual Review, and fail closed when the causal baseline history is insufficient.