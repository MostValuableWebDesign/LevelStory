---
name: Early ORB provenance
description: How merged historical occurrences retain authoritative Early ORB identity when canonical attribution is ORB pullback.
---

An Early ORB occurrence remains authoritative when its generated `early-orb|...` eligibility arm or `early orb momentum` provenance survives the causal merge, even if ORB pullback wins canonical attribution and optional Early ORB evidence came from another audit cursor.

**Why:** Historical audit merging can choose the ORB pullback record as the best complete evidence snapshot and otherwise hide the independent Early ORB path. Treating the canonical label as the sole identity would incorrectly apply the ORB executable-level gate.

**How to apply:** Preserve Early ORB evidence while merging same-identity P→E occurrences, and recognize the Early ORB arm/provenance as a fallback identity signal. Continue enforcing NTZ, entry-window, causal-identity, and candidate-owned management validation.