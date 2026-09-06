---
name: Patience entry hard gate
description: The final execution path must independently require complete P→immediate-E evidence.
---

Only a completed patience candle followed by its immediately adjacent completed confirmation candle may qualify an executable setup or create a shadow fill. A descriptive setup evaluation is not sufficient on its own.

**Why:** A setup could otherwise appear qualified while the execution path accepted incomplete or non-patience evidence, making visible P candles and actual entry acknowledgment disagree.

**How to apply:** Keep the shared confirmation predicate at both setup-selection and Phase 8 execution boundaries; if the evidence is missing, preserve the diagnostic timeline and explain that no shadow fill was created.