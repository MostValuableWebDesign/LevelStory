---
name: Patience buffer semantics
description: Durable rules for trend-aligned patience candles, immediate triggers, and buffered risk evidence.
---

The patience engine treats a raw facing-extreme break as observation, not entry. A trigger is valid only after the same immediate candle reaches the complete three- or four-tick confirmation buffer; intrabar ordering evidence may resolve ambiguity but cannot waive that buffer. The opposite patience extreme invalidates the setup, and a closed immediate candle that never reaches the buffer expires it.

**Why:** A first implementation allowed first-break evidence to trigger at the raw extreme, which contradicted the user's explicit buffered-entry rule and could create false setup qualifications.

**How to apply:** Preserve the distinction between raw-break waiting, buffered entry reached, and completed entry-triggered states in evaluator logic, setup gates, replay, risk sizing, journal evidence, and UI copy.