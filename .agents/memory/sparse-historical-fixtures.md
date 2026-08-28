---
name: Sparse historical fixtures
description: Test-design guidance for historical import coverage and gap classification.
---

When testing a small set of complete historical sessions, import each synthetic trading date independently when the assertion concerns that date's session or post-close gap. Combining isolated dates without overnight rows creates unrelated inter-date missing intervals that are correctly classified as unexpected.

**Why:** The importer classifies every interval between adjacent rows, so a sparse multi-date fixture can fail for the intended gap-classification reason even when the calendar behavior is correct.

**How to apply:** Use one-minute rows covering the full expected regular window, add a row after an early close when validating expected closure, and keep separate assertions for eligibility and cross-session gap behavior.