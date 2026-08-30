---
name: Consolidation threshold governance
description: Rules for preserving governed Phase 6 consolidation threshold provenance and cache identity.
---

The active Phase 6 consolidation threshold configuration is part of the strategy formula identity, and its version plus exact values must remain visible on both audit records and immutable historical occurrence rows.

**Why:** A default-only fingerprint can reuse results produced under a different active governed configuration, while ledger consumers cannot verify the rule that produced an occurrence if provenance exists only on the parent audit row.

**How to apply:** When changing any governed consolidation threshold or its version, update the typed configuration, diagnostic evidence, formula/cache identity, audit schema, occurrence schema, and deterministic boundary tests together. Keep the 24-tick maximum explicitly labeled as an unvalidated trading assumption unless independent evidence changes that status.