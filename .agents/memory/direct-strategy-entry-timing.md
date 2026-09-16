---
name: Direct strategy entry timing
description: Equivalent reversal uses the next candle; close-gated consolidation does not execute on its breakout candle or defer it automatically.
---

Equivalent-Candle Reversal must not retroactively fill inside the second pattern candle whose close makes the setup knowable. Its candidate-owned threshold observation belongs to the immediately following completed five-minute candle; patience and P/E identity fields remain null. Strong Breakout After Consolidation remains close-gated: qualification is known at the breakout candle close, the breakout candle cannot execute, and the system must not silently substitute the following candle.

**Why:** A completed equivalent-pattern candle is causal evidence, not future permission to use an earlier intrabar crossing. The consolidation close gate makes any breakout-candle fill causally unavailable; automatic next-candle substitution would create a trade that the selected timing contract did not authorize.

**How to apply:** Keep direct occurrences separate from patience lifecycle validation. Use the frozen consolidation range or second pattern candle for threshold/stop geometry; preserve ordered intrabar handling in the shared simulator for evidence-level cases, but reject production same-candle consolidation identity when qualification occurs at or after the breakout close. Preserve legacy P/E behavior elsewhere.