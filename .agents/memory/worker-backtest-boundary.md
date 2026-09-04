---
name: Worker backtest boundary
description: CPU-bound causal backtests must run outside the API event loop and be packaged as a separate runtime entry.
---

The backtest deadline must own a terminable worker, not race a synchronous function. For large historical replays, index loading and replay-dataset construction must cross the worker boundary too; cloning a fully built dataset can still block the API thread. Worker protocols that stream progress must keep a persistent message listener until the terminal result/error; a one-shot listener consumes the first progress event and turns every later outcome into a false clean-exit failure. A successful worker result may be cached only after the parent receives it; timeout, error, and abnormal-exit paths must release capacity and reject without a late cache write. Month-scale `trades_and_diagnostics` snapshot projection can still exceed the deadline even when the causal replay finishes; bounded funnel-only slices and `trades_only` review generation are safer analysis paths.

**Why:** JavaScript timers, HTTP timeouts, and cleanup callbacks cannot interrupt CPU-bound work running on the API thread. Structured-cloning a large historical dataset or synchronously preparing it before worker creation can create the same gateway failure even when the final backtest runs in a worker. Progress changes the worker contract from one terminal message to a stream plus one terminal message.

**How to apply:** When changing the backtest runner, keep the worker as a separately bundled entry, load/prepare large historical inputs inside that worker, and keep the parent-side lifecycle responsible for timeout, termination, and cache publication. Resolve bundled worker URLs from the emitted dist tree, not the source module path.