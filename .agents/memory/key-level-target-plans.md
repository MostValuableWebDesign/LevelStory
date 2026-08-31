---
name: Key-level target plans
description: Deterministic MES target selection freezes causal levels and near-side placement per candidate.
---

Key-level profit targets must be selected from the causal snapshot available at entry, with MES's 12-tick buffer applied before the next directional level. The target allowlist excludes Fibonacci, close, critical, and management artifacts; if no allowed level survives, the candidate stays open and unscored rather than using a legacy target. Nearby and behind-entry levels remain auditable as skipped or rejected evidence, while the selected level and subsequent levels belong to that candidate's frozen management plan.

**Why:** A shared session target or a later chart level can make two same-session occurrences resolve differently from the evidence that was actually available when each entry became eligible.

**How to apply:** Freeze the allowlisted inputs with source audit/cursor provenance, keep target-plan identity alongside candidate-owned management, and propagate it into modeled trade audit and Visual Review; never let legacy target fields replace an already-frozen candidate plan.