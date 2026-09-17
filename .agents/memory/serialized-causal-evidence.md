---
name: Serialized causal evidence
description: Rules for preserving and validating direct setup trend evidence across replay projections.
---

Direct setup evidence is only executable when its direction matches the trade, its source is recognized, and its availability timestamp is finite and no later than setup authorization. Serialized timestamps must be parsed explicitly; malformed or missing values must produce diagnostics rather than exceptions.

**Why:** A serialized timestamp was previously treated as numeric detector evidence and missing values were converted with `toISOString()`, causing runtime errors and allowing later breakout evidence to authorize an earlier crossing.

**How to apply:** Preserve source and availability time from the detector through snapshot, audit, occurrence, candidate, management, execution identity, and review projections. Validate again at candidate projection so hand-built or stale historical rows cannot bypass the causal boundary.