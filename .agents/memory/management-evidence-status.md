---
name: Management evidence status
description: Distinguishes absent management evidence from invalid frozen execution geometry.
---

Use `missing` only when required management evidence is absent. Use `invalid` when the evidence exists but fails price ordering, timestamp, quantity, or runner-direction validation.

**Why:** Treating both states as missing hides whether a candidate lacks evidence or contains contradictory evidence, and can make downstream metrics and review misleading.

**How to apply:** Preserve the confirmed candidate in both cases, but never simulate invalid management; leave its trade open with zero realized accounting and report the exact validation reasons.