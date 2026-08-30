---
name: Patience wick invalidation
description: Rules for distinguishing an opposite-wick touch from a breach and pairing historical P/E occurrences with their trade-owning audit.
---

The opposite patience wick must be exceeded to invalidate a continuation candidate; equality is a touch and must not be treated as a breach. A confirmed later P→E occurrence may remain executable after an earlier candidate is invalidated or ambiguous.

**Why:** Historical Visual Review exposed a valid bullish P→E pair as ambiguous because inclusive wick comparisons and stale same-session audit association obscured the exact occurrence.

**How to apply:** Use strict beyond-wick comparisons for continuation patience. Historical modeled execution may consume a completed causal E candle surfaced after its original cursor, but must deduplicate by contract, strategy, direction, and E candle. When projecting occurrences, prefer an audit with matching P/E timestamps and a matching trade; allow null pre-fill/exit fields on earlier audits rather than rejecting the causal match. A canonical patience occurrence may also project into Qualified trades while retaining its patience category.