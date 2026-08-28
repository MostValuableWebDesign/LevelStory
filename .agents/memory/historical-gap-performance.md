---
name: Historical gap performance
description: Performance constraint for session-aware missing-minute classification across large historical files
---
Session-aware gap accounting should use overlaps between missing spans and session intervals rather than iterating over every missing minute.

**Why:** Full historical files contain long maintenance, weekend, holiday, and inactive-contract spans; per-minute classification can push otherwise valid extended backtests into request-timeout territory.

**How to apply:** Keep category intervals disjoint and sum their minute overlaps, with the unclassified remainder assigned to expected weekend/holiday closure.