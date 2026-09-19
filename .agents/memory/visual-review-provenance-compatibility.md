---
name: Visual Review provenance compatibility
description: Human review context may only be considered compatible when the causal occurrence and result provenance both match.
---

An occurrence identity alone is not sufficient to transfer or interpret a human review across Visual Review result versions. A changed source, strategy, formula, chart projection, or ordered intrabar chronology blocks inheritance; the old review remains attached to its immutable result.

**Why:** Reusing a review against changed candles, levels, fills, stops, targets, outcomes, or entry-candle chronology would make human labels appear to validate evidence they never inspected.

**How to apply:** Keep result versions immutable, compare stable causal occurrence identity plus source/analysis/chart provenance and the versioned ordered-evidence payload, expose blocked compatibility explicitly, and never copy the review automatically.