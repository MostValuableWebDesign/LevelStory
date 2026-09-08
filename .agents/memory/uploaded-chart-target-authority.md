---
name: Uploaded chart target authority
description: Durable rule for keeping uploaded-chart analysis consistent with generated and replayed candidates.
---

Uploaded-chart analysis must convert visible level evidence into the shared key-level target planner before producing an executable target. A vision model's field labeled “target” is evidence, not order authority.

**Why:** Directly accepting a chart-extracted target bypasses the universal near-side buffer, reward/range eligibility, skipped-level diagnostics, and exact 1R fallback used by the deterministic execution paths.

**How to apply:** Preserve raw visible levels and provenance, call the shared planner with the governed eight MES ticks, and expose the resulting plan metadata to review and replay consumers.