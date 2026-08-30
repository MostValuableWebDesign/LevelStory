---
name: Ledger signal taxonomy
description: Rules for separating confirmed signals, modeled trades, risk outcomes, and patience-arm lifecycle state.
---

Confirmed signals must be sourced from ledger occurrences, not reconstructed from broad audit states. A patience signal is confirmed only when its immediate next E candle reaches the full configured buffer; classify its review-window membership by E open time, with the 1:00 p.m. ET boundary exclusive. A confirmed P→E consumes its originating eligibility arm, while an ambiguous event-order result remains recoverable unless the opposite side is actually breached.

**Why:** Audit records combine setup, risk, execution, and outcome information, so using them as a confirmed-signal source can surface unconfirmed or non-canonical examples. Arm consumption prevents one causal L interaction from producing multiple signals, while conservative ambiguity handling preserves valid later evidence.

**How to apply:** Keep ledger statuses explicit (`ENTRY_CONFIRMED`, `ENTRY_CONFIRMATION_FAILED`, `RISK_REJECTED`, `RISK_APPROVED_EXECUTION_UNAVAILABLE`, and `MODELED_TRADE`), carry arm identity/provenance into occurrence evidence, and use the governed strategy window everywhere signals are filtered or taught.