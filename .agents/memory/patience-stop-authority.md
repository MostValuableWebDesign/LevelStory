---
name: Patience stop authority
description: The causal source and invariant for patience strategy stops across replay and review.
---

The patience strategy stop must be recalculated from the frozen P extreme, direction, governed buffer ticks, and contract tick size. If the opposite P wick is within 12 MES ticks of a causal adverse primary level/indicator, that reference is the first loss exit and the P-wick stop is the secondary fallback.

**Why:** Management evidence, OHLCV execution, audit records, ledger metrics, and Visual Review must agree on causal exit precedence while still preserving the governed P-wick stop when no nearby adverse primary reference is available.

**How to apply:** Preserve the P timestamp, extreme, buffer, tick size, and calculated stop together when projecting a candidate. Freeze the adverse primary reference when its P-wick vicinity qualifies, resolve it before the P stop, and fall back to the recalculated P stop otherwise.

Visual Review should plot the frozen primary stop barrier as its own machine-visible annotation and event. Keep the actual execution fill separate when slippage or quote resolution moves it away from that barrier.

**Why:** A filled-price marker can make a correctly prioritized primary stop look like the wrong level, especially in historical OHLCV mode where the modeled fill may include slippage.

**How to apply:** Use the stored primary reference stop for the labeled stop line, hit event, and event-rail price; use the trade exit price only for the actual-fill overlay and audit detail.