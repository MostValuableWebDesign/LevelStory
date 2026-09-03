---
name: Chart label contract
description: Visual Review price-level labels must remain visible for every available priced primary reference.
---

Every available, priced primary reference in a Visual Review snapshot must render a human-readable label either beside its in-domain chart level or in the out-of-domain edge indicator; special execution levels use canonical STOP, TARGET, 1R TARGET, and RUNNER names.

**Why:** A line without a nearby name is ambiguous in a dense historical chart, especially when target, runner, entry, and stop levels overlap structural references.

**How to apply:** Keep the label naming rule shared by the in-domain plot renderer and edge-indicator renderer, and test both the annotation eligibility contract and the JSX label paths when adding new primary-level IDs.