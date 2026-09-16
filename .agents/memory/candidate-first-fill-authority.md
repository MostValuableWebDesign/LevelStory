---
name: Candidate-first fill authority
description: Ordering rule for candidate-driven Shadow Mode entry and legacy trade reconciliation.
---

An eligible candidate must establish its candidate-owned Shadow Mode fill through the shared execution simulator before legacy modeled trades are reconciled. The trigger threshold, actual modeled fill price/timestamp, and E-close observation are separate evidence; legacy trades cannot create or suppress the fill.

**Why:** A threshold touch can still be an unresolved OHLCV entry/exit ordering or can fill at a later observed intrabar price. Treating the threshold as the fill produces incorrect P/L, arbitration order, and Visual Review evidence.

**How to apply:** Derive candidate execution status from the simulator, keep unfilled/ambiguous candidates out of authoritative positions, and link at most one established trade by both candidate and signal occurrence IDs. Preserve trigger threshold in audit fields while using actual fill price/time for accounting and position arbitration.