---
name: Candidate-first fill authority
description: Ordering rule for candidate-driven Shadow Mode entry and legacy trade reconciliation.
---

An eligible candidate whose immediate E candle reaches the confirmation threshold must materialize its candidate-owned Shadow Mode fill before legacy modeled trades are reconciled. Legacy trades are corroborating, conflicting, or duplicate evidence; they are not permission to create or suppress the fill.

**Why:** Tying candidate status or fill creation to a pre-existing legacy trade can produce contradictory states where the threshold was reached but no authoritative fill exists, or where Visual Review displays entry evidence without stable candidate ownership.

**How to apply:** Derive candidate execution status from the authoritative E disposition, create at most one exact-threshold trade linked by both candidate and signal occurrence IDs, and then classify legacy trades without allowing them to alter that result.