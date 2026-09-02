---
name: Snapshot-wide consolidation overlays
description: Product rule for showing consolidation ranges in Visual Review trade snapshots.
---

Visual Review must highlight every qualifying consolidation range visible in a trade snapshot, regardless of the snapshot trade's entry location or whether that range caused the entry.

**Why:** A trade snapshot is used to inspect the whole candle story; tying the visual overlay to the entry-specific guard hides other valid consolidation ranges and misrepresents the session context.

**How to apply:** Scan the snapshot's completed contiguous candle series with the governed consolidation thresholds, render each maximal non-overlapping range using its own source interval and frozen high/low, and render nothing when no valid range exists.