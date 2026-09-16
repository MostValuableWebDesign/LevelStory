---
name: Management evidence status
description: Distinguishes absent management evidence from invalid frozen execution geometry.
---

Use `missing` only when required management evidence is absent. Use `invalid` when the evidence exists but fails price ordering, timestamp, quantity, or runner-direction validation.

**Why:** Treating both states as missing hides whether a candidate lacks evidence or contains contradictory evidence, and can make downstream metrics and review misleading.

**How to apply:** Preserve the confirmed candidate in both cases, but reject missing or invalid management before authoritative simulation and account-position arbitration. Keep the candidate diagnostics and exact validation reasons; only complete valid fills may become trades.