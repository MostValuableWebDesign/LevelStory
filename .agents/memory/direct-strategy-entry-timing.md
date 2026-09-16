---
name: Direct strategy entry timing
description: The two authorized no-patience strategies qualify on completed setup evidence and execute only in the following completed candle.
---

The authorized Strong Breakout After Consolidation and Equivalent-Candle Reversal contracts must not retroactively fill inside the candle whose close makes the setup knowable. Their candidate-owned threshold observation belongs to the immediately following completed five-minute candle; patience and P/E identity fields remain null.

**Why:** A completed breakout close or the second completed equivalent-pattern candle is causal evidence, not future permission to use an earlier intrabar crossing. Reusing the qualifying candle would create look-ahead and violate the specification's timing rule.

**How to apply:** Keep the direct strategy occurrence separate from patience lifecycle validation. Use the frozen consolidation range or second pattern candle for threshold/stop geometry, require the next adjacent candle for execution, and preserve all legacy P/E behavior for other strategies.