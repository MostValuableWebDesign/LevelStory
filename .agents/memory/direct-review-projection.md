---
name: Direct review projection
description: The visual-review projection boundary for direct consolidation and equivalent-candle candidates.
---

Direct visual-review snapshots must carry direct setup provenance from the historical occurrence into the displayed audit, and must reconcile the displayed trade audit with that same authoritative stop before rendering annotations or chart evidence.

**Why:** The replay occurrence can have the correct frozen consolidation range and structural stop while the legacy modeled trade still contains a patience-derived stop. If the projection exposes the legacy trade unchanged, the chart shows the wrong level and lacks the source timestamps needed to preserve a range that ended before entry.

**How to apply:** When adding or changing a direct strategy, keep the frozen high/low, source candle timestamps, and authoritative stop together through `buildMachineSnapshot`, `machineEvidence`, `tradeEvents`, and chart annotation inputs.