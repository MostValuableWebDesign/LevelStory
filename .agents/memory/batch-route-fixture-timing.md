---
name: Batch route fixture timing
description: Why batch route integration tests can fail independently of production worker behavior
---

Batch route tests must not run the full causal replay synchronously inside the HTTP event loop. A controlled test worker that emits a message and performs the replay inline can block the initial 202 response, status polling, or funnel request long enough for the client connection to reset. This is especially visible when the batch runs normal and multiple stress-cost partitions.

**Why:** Production batch execution uses a separately managed worker, while the in-process fixture has different event-loop behavior and can make a passing route appear broken under load.

**How to apply:** Use a non-blocking worker fixture or run the replay outside the test server event loop. Keep the route assertions for initial acceptance, status transitions, cancellation, and completed funnel access.