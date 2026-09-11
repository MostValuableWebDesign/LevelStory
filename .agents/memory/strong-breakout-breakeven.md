---
name: Target-trade breakeven removal
description: Target-bound trades no longer use the shared nine-tick favorable-excursion breakeven trigger.
---

Target-bound strategies do not arm breakeven from a universal favorable-excursion tick threshold. The six-completed-bar rule remains only for no-forward-level management, and post-target runner protection remains a separate management rule.

**Why:** The shared nine-tick trigger changed outcomes across every target-bearing strategy and mixed target management with no-target recovery semantics. Removing it keeps target exits governed by their frozen target/stop plans and preserves the distinct runner-management behavior.

**How to apply:** Do not add a target-bound breakeven trigger to strategy configuration or execution calls. Keep no-level completed-bar breakeven and post-target runner protection separate.