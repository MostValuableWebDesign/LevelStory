---
name: Patience stop authority
description: The causal source and invariant for patience strategy stops across replay and review.
---

The strategy stop for a patience candidate must be recalculated from the candidate's frozen P extreme, direction, governed buffer ticks, and contract tick size. A raw P extreme or stale legacy/risk-plan stop is not authoritative.

**Why:** Management evidence, OHLCV execution, audit records, ledger metrics, and Visual Review must describe one identical causal stop; accepting an older stop formula creates contradictory exits and P/L.

**How to apply:** Preserve the P timestamp, extreme, buffer, tick size, and calculated stop together when projecting a candidate. Recompute from that evidence at execution boundaries and reject or replace stale raw-extreme values.