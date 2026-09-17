---
name: Direct review projection
description: The visual-review projection boundary for direct consolidation and equivalent-candle candidates.
---

Direct visual-review snapshots must carry direct setup provenance from the historical occurrence into the displayed audit, and must reconcile the displayed trade audit with that same authoritative entry/stop geometry before rendering annotations or chart evidence. If the occurrence object is unavailable, reconstruct Strong Breakout geometry from the audit's frozen zone; if the modeled fill is not strictly outside that zone, withhold the trade projection.

**Why:** The replay occurrence can have the correct frozen consolidation range and structural stop while the legacy modeled trade still contains a patience-derived entry or stop. If the projection exposes the legacy trade unchanged, the chart shows the wrong level and lacks the source timestamps needed to preserve a range that ended before entry.

**How to apply:** When adding or changing a direct strategy, keep the frozen high/low, source candle timestamps, authoritative threshold, actual outside-zone fill, and structural stop together through `buildMachineSnapshot`, `machineEvidence`, `tradeEvents`, and chart annotation inputs.