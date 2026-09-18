---
name: Direct review projection
description: The visual-review projection boundary for direct consolidation and equivalent-candle candidates.
---

Direct visual-review snapshots must carry direct setup provenance from the historical occurrence into the displayed audit, and must reconcile the displayed trade audit with that same authoritative entry/stop geometry before rendering annotations or chart evidence. If the occurrence object is unavailable, reconstruct Strong Breakout geometry from the audit's frozen zone; if the modeled fill is not strictly outside that zone, withhold the trade projection.

**Why:** The replay occurrence can have the correct frozen consolidation range and structural stop while the legacy modeled trade still contains a patience-derived entry or stop. If the projection exposes the legacy trade unchanged, the chart shows the wrong level and lacks the source timestamps needed to preserve a range that ended before entry.

**How to apply:** When adding or changing a direct strategy, keep the frozen high/low, source candle timestamps, authoritative threshold, actual outside-zone fill, and structural stop together through `buildMachineSnapshot`, `machineEvidence`, `tradeEvents`, and chart annotation inputs.

At candidate projection time, pass validated direct frozen-zone provenance into the consolidation guard instead of reconstructing it from a later visible candle window. The guard must retain the direct source timestamps and crossing identity.

**Why:** A later replay cursor can preserve the direct audit's frozen range while a second guard reconstruction lacks the exact crossing boundary and returns no zone, causing a valid direct occurrence to be rejected as missing frozen geometry.

**How to apply:** If a direct evaluation carries validated frozen consolidation evidence, use that evidence for guard identity and geometry; only reconstruct for paths without authoritative direct provenance.