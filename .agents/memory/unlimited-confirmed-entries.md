---
name: Unlimited confirmed entries
description: Early ORB entry-count behavior and the safety rules that remain authoritative.
---

There is no per-direction entry-count cap. Every eligible Early ORB patience candle is evaluated independently, and every confirmed P→immediate-E sequence remains available for candidate projection.

**Why:** A fixed one-entry allowance could suppress later valid patience sequences even when each sequence had its own causal P, adjacent E, and full confirmation buffer.

**How to apply:** Do not restore an attempt counter. Preserve the independent gates for patience shape, immediate adjacency, eight-tick confirmation, session cutoff, NTZ position, and downstream risk/management.