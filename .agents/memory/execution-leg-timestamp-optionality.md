---
name: Execution-leg timestamp optionality
description: Why modeled execution leg candle timestamps remain optional.
---

Modeled execution legs may carry their exit candle open and close timestamps, but those fields must remain absent when a legacy or unit-test candle has no valid timestamp.

**Why:** The execution simulator is also exercised with compact candle fixtures that intentionally omit time metadata. Emitting an invalid ISO timestamp would break otherwise valid execution calculations and make the evidence contract less truthful.

**How to apply:** Validate candle timestamps before serializing leg evidence; let Visual Review fall back to the trade-level exit timestamp only when a leg-specific timestamp is unavailable.