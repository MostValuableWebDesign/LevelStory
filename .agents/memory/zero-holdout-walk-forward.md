---
name: Zero-holdout walk-forward
description: Required behavior when visual review requests only in-sample dates.
---

Walk-forward evaluation must return an empty fold list when the requested holdout duration is zero. The overall report can still calculate its descriptive metrics over the selected dates.

**Why:** Visual Review permits `outOfSampleDays: 0`; using that value as the fold-loop increment causes an infinite loop that eventually throws `RangeError: Invalid array length`.

**How to apply:** Guard fold generation before the loop whenever the in-sample or out-of-sample duration is non-positive. Preserve the aggregate metrics and do not change trading or qualification rules.