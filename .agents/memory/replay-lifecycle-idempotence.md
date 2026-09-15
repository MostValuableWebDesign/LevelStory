---
name: Replay lifecycle idempotence
description: How to interpret repeated pullback lifecycle transitions emitted by causal replay cursors.
---

Repeated replay cursors may re-emit a later `LEVEL_INTERACTION_FOUND` transition with `ARMED_AFTER_BREAKOUT`, `PULLBACK_OBSERVED`, or `LEVEL_INTERACTION_FOUND` as its predecessor even though the same causal arm has already advanced in the reducer. These are idempotent observations of one non-terminal arm, not a new arm or a lifecycle conflict. Terminal arm states remain immutable; a later terminal observation must not reopen the arm.

**Why:** The historical reducer consumes progressively larger replay prefixes, so each prefix can contain the same arm's full path with a different latest level interaction. Treating the serialized predecessor as authoritative produced false lifecycle conflicts and hid otherwise eligible confirmed signals.

**How to apply:** When adding lifecycle reconciliation or diagnostics, compare transitions within the canonical arm identity and confirmation time. Allow only the known non-terminal rearm shapes; reject terminal-state rewrites and preserve the causal timestamp of the later valid interaction.