---
name: Account-wide position arbitration
description: The account-level rule for preserving candidate evidence while enforcing one active trade across historical and shadow replay.
---

The account gate is applied after strategy-specific candidate execution is produced and before authoritative trades or performance metrics are finalized. Candidates are processed chronologically across strategies, directions, contracts, and dates. A fully evidenced exit at or before the next candidate entry permits the next entry; open, missing, invalid, or ambiguous full-exit evidence blocks conservatively. A two-contract position remains active while its runner or remaining quantity is open. Scoring ambiguity is separate from lifecycle ambiguity: an adverse-first trade with a valid full-exit timestamp, exit legs, and zero remaining quantity remains unscored but releases the gate; an unresolved ambiguous trade remains active.

**Why:** Strategy-local execution can identify every qualifying opportunity, but account-wide P/L must never imply simultaneous positions when the product allows only one active trade.

**How to apply:** Keep blocked candidates in projection, Visual Review, and replay evidence with blocker IDs and timestamps. Preserve candidate-owned hypothetical executions separately from authoritative trades so Shadow Replay can recompute one- versus two-contract blocking. Exclude blocked candidates from authoritative trades, ledger/P&L, and performance statistics. Reuse the shared gate for every aggregation layer, including multi-date Phase 3 reports.