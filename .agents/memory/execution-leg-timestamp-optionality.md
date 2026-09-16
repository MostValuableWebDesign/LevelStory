---
name: Execution-leg timestamp optionality
description: Why modeled execution leg candle timestamps remain optional.
---

Modeled execution legs may carry an exact ordered intrabar exit timestamp plus exit-candle open and close timestamps, but those fields must remain absent when a legacy or unit-test candle has no valid timestamp.

**Why:** Account arbitration needs the exact event timestamp when ordered evidence exists, while Visual Review still needs the enclosing candle observation. The simulator is also exercised with compact candle fixtures that intentionally omit time metadata, so emitting an invalid ISO timestamp would make the evidence contract less truthful.

**How to apply:** Prefer an ordered tick crossing for trade/account event time, retain candle-close observation separately, and validate all timestamps before serializing leg evidence. Let Visual Review fall back to the trade-level exit timestamp only when a leg-specific timestamp is unavailable.