---
name: Orphan modeled-trade provenance
description: Preserve legacy modeled-trade evidence when a cached pilot is corrected from raw audits.
---

When a cached historical pilot is rewritten from its raw audit stream, retain the prior orphan modeled-trade records separately from the current authoritative trade list. A later resume must be able to explain each previously orphaned trade and only restore it when an exact eligible physical candidate matches.

**Why:** Reconciliation can resolve an orphan after fixing occurrence identity or candidate projection. Dropping the old record during the first checkpoint rewrite makes the result non-auditable on every later resume.

**How to apply:** Keep orphan history in the persisted checkpoint/report as provenance, while treating the current projection's orphan list as the authoritative set of still-unresolved exclusions. Resolve historical entries by exact signal/candidate identity, not by setup label.