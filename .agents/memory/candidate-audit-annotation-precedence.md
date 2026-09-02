---
name: Candidate audit annotation precedence
description: Visual Review chart levels for candidate trades must come from candidate-owned audit data, not legacy record-level evidence.
---

When a Visual Review snapshot has a candidate-owned trade, plot strategy and execution levels from that trade's frozen audit. Legacy record-level audit fields remain reconciliation evidence and must not override candidate-owned values in the chart.

**Why:** A stale legacy stop can be displayed under the active "Strategy stop" label even when the candidate exited at session close, making a non-operative barrier appear to have controlled the trade.

**How to apply:** Give candidate trade audit fields precedence for plotted levels and hit markers; only fall back to record-level fields for non-candidate legacy visualizations.