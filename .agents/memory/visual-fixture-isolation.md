---
name: Visual fixture isolation
description: Durable boundary for truthful visual-review category fixtures and causal identity.
---

Visual-review category samples must use independent deterministic fixture sequences and must match trades through the full causal identity: contract, date, patience, trigger, modeled fill, and exact exit candle timestamps. Keep this fixture layer separate from shared strategy, execution, and backtest behavior.

**Why:** Reusing one simulator sequence and matching on broad metadata caused different categories to display the same candle shapes, contradictory trend evidence, and unrelated exit outcomes.

**How to apply:** When adding or changing visual-review samples, preserve raw OHLCV values, give every category its own valid continuous sequence, encode category-specific machine evidence explicitly, and reject partial or ambiguous audit/trade matches.