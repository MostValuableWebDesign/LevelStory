---
name: Visual chart pointer separation
description: Interaction rules for Visual Review’s free-roaming crosshair and fixed-candle inspection.
---

The chart crosshair’s X/Y position and displayed price must be tracked independently from the fixed five-minute slot used for candle inspection. The SVG needs an explicit interaction surface so empty plot slots and the price-axis edge remain interactive; keyboard navigation remains slot-snapped.

**Why:** SVG child geometry and gaps do not reliably provide pointer targets, and deriving the crosshair from the selected candle makes Y movement appear snapped or substitutes OHLCV into empty slots.

**How to apply:** Use pointer coordinates for crosshair lines and tick-rounded price, resolve the inspector from X only, and preserve a single inspector that clearly labels crosshair price separately from nearest-candle OHLCV.