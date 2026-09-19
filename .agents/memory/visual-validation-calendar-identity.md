---
name: Visual validation calendar identity
description: Visual Review freshness must compare the actual session-calendar version, not the multi-contract rollover schedule version.
---

Visual Review cache metadata must use the contract's session-calendar version for freshness checks; the multi-contract rollover schedule version is a separate identity.

**Why:** A freshly generated historical set can contain correct snapshots but be marked stale when a rollover schedule identifier is stored in the session-calendar field, causing the UI to hide the set.

**How to apply:** When building full or partial historical Visual Review sets, derive `sessionCalendarVersion` from the contract session calendar and reserve `contractSchedule.version` for rollover provenance.