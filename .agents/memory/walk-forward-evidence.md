---
name: Walk-forward evidence
description: Durable guardrails for chronological validation and cost sensitivity in the futures research surface
---

Walk-forward validation is descriptive research, not parameter selection: folds must preserve chronology, keep each out-of-sample window untouched, and report cost scenarios independently without choosing a winner.

**Why:** Selecting a favorable fold, cost case, or future window would turn the validation output into an optimization loop and overstate evidence.

**How to apply:** Keep formula identity stable across normal and stress runs, preserve exact dates/contracts in fold output, and use neutral evidence labels whenever sample size or stability is insufficient.