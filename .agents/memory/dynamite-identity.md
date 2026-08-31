---
name: Dynamite identity
description: Durable identity and performance constraints for Dynamite confluence clusters.
---

Dynamite cluster identity must include source identity, formula/configuration identity, contract, trading date, causal observation time, normalized bounds, and sorted canonical source families. Names that cannot be classified into a canonical family must be excluded rather than silently treated as support.

**Why:** Confluence is evidence for one physical signal, so a cluster must not collide across replay sources, formula versions, contracts, dates, or family composition. Snapshot generation is frequent, so source identity should be supplied by the caller when available; a derived descriptor fallback must remain bounded rather than hashing every historical candle on every request.

**How to apply:** Keep exact interaction attribution tied to the signal's causal event/L/P/E identity. Preserve cluster IDs as strings in API responses, and use bounded source fingerprint derivation for generated feeds unless an authoritative fingerprint is provided.