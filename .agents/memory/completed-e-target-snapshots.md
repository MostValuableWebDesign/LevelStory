---
name: Completed-E target snapshots
description: Target snapshots must be selected from one canonical, confirmed, completed immediate E candle.
---

The authoritative target snapshot for a physical P→E occurrence must match the canonical E open and completed E close, belong to the same confirmed signal identity, and be frozen at E close. If multiple valid audits observed that E, retain the earliest valid snapshot; never fall back to an earlier incomplete or unrelated snapshot.

**Why:** An audit cursor can identify an E candle before that candle is causally complete, and an unsafe fallback can import later or unrelated key levels into execution and Visual Review.

**How to apply:** Treat target availability as independent from stop, catastrophe-stop, and session-close management evidence. When no eligible target exists, pass a null target through the normal OHLCV simulator so independently valid exits still execute while target-hit evidence remains absent.