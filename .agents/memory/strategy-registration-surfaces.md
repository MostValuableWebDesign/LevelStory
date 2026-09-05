---
name: Strategy registration surfaces
description: New strategy IDs must be wired through every downstream selection and reporting registry
---

Adding a strategy is not complete when taxonomy and evaluators recognize it; historical replay selection and dashboard setup-performance registries must also include it.

**Why:** Those registries intentionally use ordered allowlists, so a strategy can qualify successfully yet never enter replay or appear in performance summaries unless each surface is updated.

**How to apply:** When adding a strategy ID, search for ordered setup arrays and canonical performance lists after updating taxonomy, then add the strategy with the intended precedence and regenerate API contracts.