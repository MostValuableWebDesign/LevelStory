---
name: Visual review invariant isolation
description: Why historical visual-review reconstruction must not abort on dashboard-state consistency contradictions
---

Visual review should preserve and render raw historical audit evidence even when reconstructing a partial dashboard snapshot would violate a live-dashboard consistency invariant. Live dashboard requests should continue enforcing those invariants.

**Why:** A date-range review is an evidence and diagnosis surface; aborting the entire generated set hides the exact contradictory state the reviewer needs to inspect and prevents the new chart from being stored.

**How to apply:** Keep invariant validation enabled by default for live market snapshots. Use an explicit review-only opt-out when the visual-validation builder reconstructs a snapshot from historical prefixes, while retaining the immutable audit and raw candle evidence.