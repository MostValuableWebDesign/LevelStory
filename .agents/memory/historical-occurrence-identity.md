---
name: Historical occurrence identity
description: Durable rules for merging causal pullback and patience evidence across strategy evaluations.
---

Historical occurrence records must be identified by the causal date, contract, direction, and L/P/E occurrence identity rather than by the setup label. The same causal sequence can be evaluated by multiple strategy candidates.

For confirmed patience signals, the physical identity is exactly source/configuration, contract/date, direction, P open, and immediate expected E open. Levels, arms, edges, status, and execution are merged provenance, not identity.

**Why:** One physical P→E pair can interact with multiple levels and match multiple strategy edges; splitting those observations creates duplicate signals and candidates.

**How to apply:** Use one canonical signal and merge qualifying levels, arm IDs, direction sources, matched edges, confluences, and audit IDs deterministically.

**Why:** Strategy taxonomy attribution is layered: ORB, consolidation, reversal, and generic patience candidates can observe the same underlying evidence. Setup-based keys duplicate that evidence and lose canonical/secondary ownership.

**How to apply:** Deduplicate by causal identity, choose the authoritative strategy using the fixed precedence order, and preserve every other matching strategy as a secondary match. Keep the evaluation cursor and exact L/P/E snapshots on the merged row.

Occurrence provenance must also retain the stable L event identity, every qualifying level observed at that same L candle, interaction/tolerance metadata, and a content-derived source fingerprint.

**Why:** A setup label or a single selected level cannot distinguish causal occurrences reliably, and metadata-only source identity allows visually identical records to collide after source candle changes.

**How to apply:** Link patience rows through the exact eligibility event when available, group same-candle qualifying level events, and include provenance in snapshot identity and review records.

A qualified trade may attach only to the patience occurrence whose completed E opens exactly when that P closes. Expired candidates remain diagnostic-only even when a later P→E pair qualifies in the same audit.

**Why:** Audit-level trade fallback can otherwise lend a later trade's E, fill, and exit markers to an earlier failed P, creating a visually valid-looking but temporally impossible sequence.

**How to apply:** Preserve the failed immediate candle and buffer comparison on the expired row, leave its entry and canonical-trade fields empty, and build trade markers only from the exact confirmed occurrence.

Review trade linkage must use the occurrence's exact P and E timestamps as a causal key, with audit-based matching only as a compatibility fallback.

**Why:** Audit records can omit or later enrich execution metadata even when the confirmed occurrence's P→E evidence is complete; requiring those optional fields hides valid confirmed trades from Review.

**How to apply:** Match contract, date, direction, strategy, period, and exact patience/entry timestamps first; accept the trade only when that occurrence-specific candidate is unique.