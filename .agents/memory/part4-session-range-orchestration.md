---
name: Cataloged session range orchestration
description: Rules for reusing per-session historical analysis while preserving combined account arbitration.
---

Cache cataloged session analysis by session, source provenance, strategy/version identity, execution settings, and session-independent request inputs. Do not include the selected date range in that key; period belongs to the individual partition.

**Why:** overlapping ranges must reuse unchanged work, while source or strategy changes must invalidate it.

**How to apply:** treat cached session reports as causal evidence only, then rerun one chronological account-position gate across the selected range before producing trades, P/L, funnel, and equity.

Upstream exits and stops affect downstream arbitration without invalidating later session evidence. Complete zero-trade results are valid cache entries; failed or incomplete session computations are never valid hits.

**Why:** account-wide position state is a combined replay concern, and a changed earlier lifecycle can change later entry authorization.

**How to apply:** keep the combined cache identity explicit about starting account state and source/strategy versions, and preserve blocked-candidate provenance when re-gating.