---
name: Synthetic A+ fixtures
description: Constraints for deterministic futures replay fixtures that must qualify through every phased gate.
---

Deterministic A+ replay fixtures must model the full market context, not only the breakout candle: post-NTZ probes stay one-sided, every completed 15-minute structure point is strictly monotonic at the contract tick size, the trigger candle meets minimum liquidity, and the account notional cap permits at least one micro contract.

**Why:** A fixture can look correct in isolated Phase 4/5 tests yet fail causal replay because an early two-sided wick creates an ambiguous probe, rounded lows/highs break strict trend structure, or risk sizing blocks the contract before execution.

**How to apply:** When adding or changing a simulated futures fixture, validate it at the actual replay checkpoint and through `/api/backtest`; test both long and short variants where direction is part of the invariant.