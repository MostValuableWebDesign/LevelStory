---
name: Entry observation timing
description: Causal timestamp semantics for historical P→E candidate replay.
---

Historical candidate eligibility is observed at the completed immediate E candle close. The E open remains the physical sequence identity timestamp; it is not the modeled entry or cutoff timestamp.

**Why:** Using E open accepts a 12:55–1:00 p.m. ET candle even though confirmation is only known at 1:00 p.m., and leaks pre-close timing into historical metrics.

**How to apply:** Carry P open, E open, and E close separately. Use E close for the strict America/New_York entry window, modeled fill observation, entry time, audit observation, and Phase 3 time buckets; use post-E candles for exit replay.