---
name: Worker backtest boundary
description: CPU-bound causal backtests must run outside the API event loop and be packaged as a separate runtime entry.
---

The backtest deadline must own a terminable worker, not race a synchronous function. A successful worker result may be cached only after the parent receives it; timeout, error, and abnormal-exit paths must release capacity and reject without a late cache write.

**Why:** JavaScript timers, HTTP timeouts, and cleanup callbacks cannot interrupt CPU-bound work running on the API thread.

**How to apply:** When changing the backtest runner, keep the worker as a separately bundled entry and keep the parent-side lifecycle responsible for timeout, termination, and cache publication.