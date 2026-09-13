---
name: Historical import resume counters
description: Checkpoint totals must be rebuilt from verified completed files when a partial file is reparsed.
---

When a resumable import restarts a partially processed file from its beginning, checkpoint counters must use the summaries of verified completed files as the baseline and replace the current file contribution with the parser's current progress. Adding the prior partial-file counters double-counts rows after resume.

**Why:** The safe checkpoint boundary is a completed file or partition, while plain CSV and compressed input may be reparsed from the next safe boundary rather than resumed at an arbitrary byte offset.

**How to apply:** Keep current-file progress separate from committed completed-file totals, and checkpoint only after the associated candle writes and partition markers succeed.