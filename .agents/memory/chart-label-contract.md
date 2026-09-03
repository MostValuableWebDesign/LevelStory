---
name: Chart label contract
description: Visual Review price-level labels must remain visible for every available priced primary reference.
---

Every available, priced primary reference that falls outside the visible chart domain must render a human-readable edge label with its top/bottom location and price. In-range chart labels stay limited to the execution levels; those use canonical STOP, TARGET, 1R TARGET, and RUNNER names.

**Why:** The chart intentionally keeps structural in-range levels readable through the legend, while an off-screen line otherwise has no visible location cue.

**How to apply:** Keep edge-indicator coverage aligned with primary-level selection, include runner thresholds in that selection, and test both the top/bottom edge paths and the special in-range execution labels when adding new primary-level IDs.