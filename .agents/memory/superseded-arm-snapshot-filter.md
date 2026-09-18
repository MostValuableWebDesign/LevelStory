---
name: Superseded arm snapshots
description: How historical lifecycle reduction handles stale replay snapshots after a causal arm is terminal.
---

Later replay cursors may retain an earlier superseded eligibility arm and re-emit a `PATIENCE_ARMED` observation after its terminal boundary. Treat that specific observation as stale provenance while preserving the terminal transition; do not suppress an explicitly active later observation, because that remains a lifecycle contradiction.

**Why:** Repeated real historical cursors produced false pullback lifecycle conflicts after a newer causal eligibility event had already superseded the old arm.

**How to apply:** In historical lifecycle reduction, derive the earliest terminal timestamp for each superseded arm and filter only post-boundary `PATIENCE_ARMED` transitions from occurrences still marked superseded. Keep terminal and consuming evidence available for reconciliation.