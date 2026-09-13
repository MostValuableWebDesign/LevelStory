---
name: Canonical historical fragments
description: Prefer one canonical non-overlapping Databento fragment per MES contract when rebuilding a full historical index.
---

When a complete canonical archive already covers the requested date range, import that non-overlapping contract set instead of combining it with overlapping recent fragments.

**Why:** Combining overlapping full-history and recent fragments exposed a historical gap-accounting failure during staged indexing, while the canonical 21-file archive committed cleanly and preserved atomic replacement.

**How to apply:** Before a large restore, compare filename date spans and choose the smallest complete non-overlapping set. Add supplemental fragments only when they extend coverage or are explicitly required, then verify the staged reconciliation before commit.