---
name: Direct strategy entry timing
description: Equivalent reversal uses the next candle; consolidation may use same-candle entry only with explicit ordered causal evidence.
---

Equivalent-Candle Reversal must not retroactively fill inside the second pattern candle whose close makes the setup knowable. Its candidate-owned threshold observation belongs to the immediately following completed five-minute candle; patience and P/E identity fields remain null. Strong Breakout After Consolidation may use the breakout candle only when an explicit qualification timestamp precedes an ordered tick threshold crossing; otherwise it uses the following completed candle.

**Why:** A completed equivalent-pattern candle is causal evidence, not future permission to use an earlier intrabar crossing. Consolidation can avoid retroactive fills only when ordered evidence proves the qualification was known before the threshold was crossed; bar-only or close-time evidence cannot establish that order.

**How to apply:** Keep direct occurrences separate from patience lifecycle validation. Use the frozen consolidation range or second pattern candle for threshold/stop geometry; accept a same-candle consolidation occurrence only with ordered tick evidence and a strictly earlier qualification timestamp; otherwise require the next completed candle and preserve legacy P/E behavior elsewhere.