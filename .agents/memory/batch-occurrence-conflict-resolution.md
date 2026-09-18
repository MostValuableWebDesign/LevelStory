---
name: Batch occurrence conflict resolution
description: Rules for duplicate causal occurrences emitted by overlapping historical replay partitions.
---

Overlapping partition reports may repeat one causal occurrence with additional audit, cursor, indicator, or management enrichment. Merge those fields deterministically. If the same occurrence disagrees on lifecycle authority, especially active versus superseded/invalidated arm state, reject the physical identity before candidate, fill, or account arbitration.

**Why:** Keeping the first partition payload can leave contradictory evidence executable, while treating every enrichment difference as a hard conflict creates false duplicate failures.

**How to apply:** Classify differing fields explicitly, preserve a rejected-identity diagnostic for contradictions, and filter that occurrence from candidates, candidate execution evidence, trades, rejected signals, and orphan linkage before global account gating.