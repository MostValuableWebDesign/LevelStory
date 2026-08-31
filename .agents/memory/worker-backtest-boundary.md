---
name: Worker backtest boundary
description: CPU-bound causal backtests must run outside the API event loop and be packaged as a separate runtime entry.
---

The backtest deadline must own a terminable worker, not race a synchronous function. For large historical replays, index loading and replay-dataset construction must cross the worker boundary too; cloning a fully built dataset can still block the API thread. A successful worker result may be cached only after the parent receives it; timeout, error, and abnormal-exit paths must release capacity and reject without a late cache write.

**Why:** JavaScript timers, HTTP timeouts, and cleanup callbacks cannot interrupt CPU-bound work running on the API thread. Structured-cloning a large historical dataset or synchronously preparing it before worker creation can create the same gateway failure even when the final backtest runs in a worker.

**How to apply:** When changing the backtest runner, keep the worker as a separately bundled entry, load/prepare large historical inputs inside that worker, and keep the parent-side lifecycle responsible for timeout, termination, and cache publication. Resolve bundled worker URLs from the emitted dist tree, not the source module path.