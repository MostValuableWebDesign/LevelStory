---
name: No-level breakeven management
description: The governed post-entry timer and conservative recovery semantics for trades without an eligible forward level.
---

Apply the no-forward-level management rule only from the frozen entry-time target disposition. Count completed post-E candles, keep the original stop and actual-fill 1R active through the configured activation bar, then arm entry as a stop when that candle closes favorable/equal or retain the original stop while arming recovery-to-entry when it closes adverse. Recovery and breakeven exits need distinct audit labels and must preserve adverse-first ambiguity.

**Why:** A timer that evaluates the entry candle or retrospectively treats the activation candle as protected changes qualification-independent execution and can create forward-data leakage or silently different P&L.

**How to apply:** Keep the activation-bar setting in governed strategy configuration, propagate it through candidate-owned OHLCV execution, and preserve numeric simulator timestamps plus serialized API audit timestamps.