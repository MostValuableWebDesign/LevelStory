---
name: Causal target indicator provenance
description: Target planning and Visual Review must calculate continuous indicators from the same contract-local, non-closed-session causal candle history.
---

The executable target snapshot must use the same causal source semantics as Visual Review: the resolved completed E candle, the candle's actual historical contract symbol, and continuous contract-local candles excluding bars classified as closed-session. VWAP uses the regular-session subset.

**Why:** Historical replay can contain midnight closed-session bars and a generic MES contract identity alongside the actual contract candle. Including those bars or anchoring to stale snapshot patience metadata produces an EMA that disagrees with the displayed causal series and can select a distant legacy level instead.

**How to apply:** When adding or changing target indicators, share the Visual Review source contract and session filters, anchor at the resolved completed E candle, and validate a persisted historical review card—not only a unit fixture.