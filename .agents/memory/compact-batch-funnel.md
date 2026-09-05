---
name: Compact batch funnel for historical analysis
description: Use the qualification batch funnel for multi-session blocker analysis instead of full Visual Review generation.
---

For large historical windows, use the compact qualification batch and funnel endpoints to analyze stage counts and rejection reasons; reserve full Visual Review generation for a small, targeted set of occurrences.

**Why:** Full historical Visual Review results carry large chart payloads and can time out or make result serialization unhealthy, while the batch funnel preserves the causal stage and rejection evidence needed for blocker analysis.

**How to apply:** Partition or batch the selected trading dates, wait for the compact report, and reconcile its funnel with `canonicalSignalsConfirmed`, `tradeCandidates`, and execution-summary diagnostics before concluding that a strategy generated no trades.