---
name: Phase 5 threshold authority
description: Phase 5 owns the effective executable confirmation price; Phase 6 only verifies strict NTZ geometry on an already confirmed E.
---

Phase 5 must calculate and persist the effective P-buffer/NTZ confirmation threshold used for entry, audit, risk, and Shadow Mode evidence. Phase 6 should reuse the shared wick-based NTZ predicate for geometric separation without reinterpreting synthetic or legacy patience prices.

**Why:** Some Phase 6 callers provide a confirmed patience state whose fixture entry price is intentionally not executable candle geometry; recalculating it there creates contradictory qualification results.

**How to apply:** Keep threshold calculation centralized in Phase 5 and pass persisted/effective values downstream. Use Phase 6 only as a setup gate over the completed E candle.