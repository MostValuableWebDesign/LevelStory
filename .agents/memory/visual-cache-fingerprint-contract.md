---
name: Visual cache fingerprint contract
description: The historical cache source identity is a composite contract identity, not necessarily a hexadecimal digest.
---

The displayed historical source fingerprint and the cache source fingerprint have different contracts: the former is a fixed-length digest, while the latter may contain multiple contract/file fingerprint components separated by delimiters. API schemas must validate the cache identity as an opaque string rather than applying the digest regex.

**Why:** A historical replay could finish successfully but return HTTP 500 when the completed generation response rejected its composite cache identity as an invalid hex digest, leaving the UI appearing stuck in the queued state.

**How to apply:** Keep digest-specific validation on source fingerprints only; treat cache source identities as opaque values in OpenAPI and generated response schemas.