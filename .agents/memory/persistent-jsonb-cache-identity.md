---
name: Persistent JSONB cache identity
description: Rules for cache keys and dependency envelopes persisted through PostgreSQL JSONB.
---

Normalize cache dependency identities to JSON-safe values before hashing or storing them in JSONB. In particular, omit undefined object properties and convert undefined array entries consistently.

**Why:** PostgreSQL JSONB serialization omits undefined object properties, while an in-memory stable serializer may otherwise include them as a distinct value. The same computation can then write a row whose dependency identity can never validate after restart.

**How to apply:** Use one JSON-safe normalization step for the full dependency envelope before computing the cache key, validating stored provenance, and writing the JSONB columns.