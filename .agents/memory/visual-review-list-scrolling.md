---
name: Visual Review list scrolling
description: Interaction rule for keeping candidate-row navigation local to the bounded trade rail.
---

Selected trade navigation must preserve the page-level chart position while ensuring the active row remains visible inside the candidate list. Adjust the bounded list's scroll position using its row and container rectangles rather than calling `scrollIntoView`, which can move the entire Visual Review page away from chart context.

**Why:** A real generated review set showed that native `scrollIntoView({ block: "nearest" })` could scroll the outer page when a row changed, hiding the chart and breaking the one-trade-at-a-time review flow.

**How to apply:** Keep the candidate rail independently scrollable, use bounded list-only scroll adjustments on selection, and verify both row selection and `window.scrollY` during browser checks.