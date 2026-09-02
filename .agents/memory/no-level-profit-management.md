---
name: No-level profit management
description: Durable candidate-owned management behavior when no frozen directional key-level target is available
---

When a candidate has no eligible farther key-level target, calculate 1R from the modeled entry fill to the operative initial stop. Do not activate structure trailing before price reaches +1R. For one contract, exit the full position at +1R; for multiple contracts, exit one contract at +1R and trail the remaining runner. A structure stop is 8 MES ticks beyond the most recent completed five-minute swing in the adverse direction, and it may only advance.

**Why:** The management rule must not invent a target when the frozen entry snapshot has no eligible level, and candle-by-candle trailing must never widen risk after profit activation.

**How to apply:** Use this only on candidate-owned historical execution. Keep the frozen key-level path separate: its near-side 12-tick target remains the first profit checkpoint, with structure trailing managing any remaining runner.