---
name: Candidate audit annotation precedence
description: Visual Review chart levels for candidate trades must come from candidate-owned audit data, not legacy record-level evidence.
---

When a Visual Review snapshot has a candidate-owned trade, plot strategy and execution levels from that trade's frozen audit. For direct consolidation or equivalent-candle occurrences, the occurrence's frozen structural stop and target plan are authoritative over any stale candidate audit; legacy record-level fields remain reconciliation evidence.

**Why:** A stale legacy or pre-candidate stop can be displayed under the active "Strategy stop" label even when the direct occurrence froze a different structural barrier, making the wrong barrier appear to have controlled the trade.

**How to apply:** Give direct occurrence-owned frozen values precedence for direct strategies, then candidate trade audit fields, and only fall back to record-level fields for non-candidate legacy visualizations.