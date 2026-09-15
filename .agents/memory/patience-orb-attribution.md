---
name: Patience continuation ORB attribution
description: Defines how ordinary patience-candle continuation trades are classified in replay and reporting.
---

Ordinary `PATIENCE_CANDLE_CONTINUATION` is a legacy evidence label, but its canonical trade, candidate, dashboard, and review classification is `ORB_PULLBACK_CONTINUATION`.

**Why:** The user clarified that patience-candle continuation trades found through the ORB context belong under the ORB strategy; keeping a separate primary strategy split the same continuation population and duplicated reporting.

**How to apply:** Preserve the patience evaluator and raw patience evidence for diagnostics and secondary matches, but canonicalize the primary edge and trade setup to ORB. Do not count a separate patience dashboard row.