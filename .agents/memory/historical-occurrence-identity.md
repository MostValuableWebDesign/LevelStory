---
name: Historical occurrence identity
description: Durable rules for merging causal pullback and patience evidence across strategy evaluations.
---

Historical occurrence records must be identified by the causal date, contract, direction, and L/P/E occurrence identity rather than by the setup label. The same causal sequence can be evaluated by multiple strategy candidates.

**Why:** Strategy taxonomy attribution is layered: ORB, consolidation, reversal, and generic patience candidates can observe the same underlying evidence. Setup-based keys duplicate that evidence and lose canonical/secondary ownership.

**How to apply:** Deduplicate by causal identity, choose the authoritative strategy using the fixed precedence order, and preserve every other matching strategy as a secondary match. Keep the evaluation cursor and exact L/P/E snapshots on the merged row.

Occurrence provenance must also retain the stable L event identity, every qualifying level observed at that same L candle, interaction/tolerance metadata, and a content-derived source fingerprint.

**Why:** A setup label or a single selected level cannot distinguish causal occurrences reliably, and metadata-only source identity allows visually identical records to collide after source candle changes.

**How to apply:** Link patience rows through the exact eligibility event when available, group same-candle qualifying level events, and include provenance in snapshot identity and review records.