---
name: Part 3 acceptance fixtures
description: Durable boundary for deterministic Visual Review acceptance coverage
---

Part 3 acceptance coverage must reuse one immutable, production-shaped market-data fixture while changing only a governed strategy configuration. The fixture should reach the real detector, occurrence ledger, candidate projection, modeled execution, Visual Review snapshot projection, and API chart-data route.

**Why:** Changing production rules or hand-authoring qualification outcomes would not prove that Visual Review responds to governed configuration changes while raw market data remains unchanged.

**How to apply:** Report before/after qualified and rejected counts, raw-data load count, strategy execution count, chart snapshot identity, source/formula/cache provenance, API status, and review compatibility status. Use separate provenance assertions for compatible, new, and blocked review states.