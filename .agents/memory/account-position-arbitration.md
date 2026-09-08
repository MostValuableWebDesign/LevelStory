---
name: Account-wide position arbitration
description: The account-level rule for preserving candidate evidence while enforcing one active trade across historical and shadow replay.
---

The account gate is applied after strategy-specific candidate execution is produced and before authoritative trades or performance metrics are finalized. Candidates are processed chronologically across strategies, directions, contracts, and dates. A fully evidenced exit at or before the next candidate entry permits the next entry; open, missing, invalid, or ambiguous full-exit evidence blocks conservatively. A two-contract position remains active while its runner or remaining quantity is open.

**Why:** Strategy-local execution can identify every qualifying opportunity, but account-wide P/L must never imply simultaneous positions when the product allows only one active trade.

**How to apply:** Keep blocked candidates in projection, Visual Review, and replay evidence with blocker IDs and timestamps. Exclude them from authoritative trades, ledger/P&L, and performance statistics. Reuse the shared gate for every aggregation layer, including multi-date Phase 3 reports.