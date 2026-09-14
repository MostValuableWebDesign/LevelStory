---
name: Intl formatting constraints
description: Browser Intl.DateTimeFormat rejects dateStyle/timeStyle when combined with timeZoneName.
---

Use explicit month/day/year/hour/minute/second fields whenever a displayed timestamp also needs a time-zone label; do not combine `dateStyle` or `timeStyle` with `timeZoneName`.

**Why:** The browser throws during render rather than returning a formatting fallback, which can trip the page error boundary only when a completed result reaches the timestamp detail view.

**How to apply:** When adding or changing timestamp formatting in the frontend, verify the full `Intl.DateTimeFormat` option set against browser runtime behavior, not only TypeScript types.