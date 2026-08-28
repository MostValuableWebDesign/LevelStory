---
name: Rollover acceptance windows
description: How to choose deterministic historical replay windows that actually exercise contract transitions.
---

Acceptance runs for multi-contract replay must end near a documented rollover boundary when validating contract isolation. A broad historical range alone is insufficient because selection intentionally takes the latest eligible sessions, which may all belong to the newest contract.

**Why:** A year-spanning request can legitimately select only the latest month and produce a false sense that rollover handling was tested.

**How to apply:** Use a 20+2 window whose selected dates straddle a known effective date, then verify the date-to-contract map and every simulated trade's contract identity independently.