---
name: Constituent-minute containment
description: Correctness rule for mapping one-minute fallback evidence into multi-contract five-minute replay candles.
---

Multi-contract one-minute fallback evidence must be assigned to the contract-local five-minute candle that fully contains it, with the same trading date and no boundary crossing. An exact-open-time match is insufficient because it keeps only the first constituent minute.

**Why:** Matching only five-minute opens silently removes minutes 2–5, so modeled stops, targets, and ambiguity decisions can change without any missing-data error.

**How to apply:** Build the association from sorted contract-local five-minute candles, reject bars that span a five-minute/session/date boundary, preserve missing bars as missing, and keep ticks as the higher-priority source.