---
name: Visual Review queue authority
description: Candidate counts and navigation must use one joined, deduplicated candidate-to-snapshot queue.
---

The Visual Review UI treats the joined candidate-to-qualified-snapshot queue as the authority for selectable counts, filtering, date groups, and navigation. Candidates that do not resolve to a reviewable snapshot remain visible in diagnostics rather than being silently omitted.

**Why:** Historical replay can retain blocked or diagnostic candidates without producing chart snapshots, while overlapping strategy edges can describe one physical candidate. Independent candidate and snapshot counts therefore create contradictory UI totals.

**How to apply:** Derive all user-facing queue views through the shared queue projection, deduplicate by canonical candidate identity, and report missing snapshot ownership separately. When no strategy filter is active, resolve each candidate to the qualified snapshot matching its primary edge before falling back to a stored snapshot ID; otherwise an overlapping candidate can display another strategy's causal chart.