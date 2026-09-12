---
name: Stored-date availability
description: Historical replay selection must be based on persisted candle presence, with rollover schedule data used only for deterministic preference and diagnostics.
---

Historical date availability is authoritative only when the committed index contains candles for the date. The CME rollover schedule may select a preferred contract when multiple contracts are stored, but it must not hide a stored date or turn schedule gaps into a selection block.

**Why:** Uploaded archives can contain valid sessions outside the configured rollover schedule or only on a fallback contract. Treating schedule eligibility as availability silently drops usable historical evidence.

**How to apply:** Use the persisted observed-date set for date pickers, replay selection, batch construction, and no-data validation. Keep scheduled eligibility fields for coverage diagnostics and audit explanations only.