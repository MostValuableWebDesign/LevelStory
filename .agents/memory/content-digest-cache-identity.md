---
name: Content digest cache identity
description: Historical CSV cache identity must be based on streamed file bytes rather than filesystem metadata.
---

Historical source identity requires a SHA-256 digest of the CSV byte stream. File path, size, and modification time are not sufficient because same-size replacements can preserve metadata and serve stale replay results.

**Why:** Cache correctness depends on content equality, while reading the stream incrementally avoids loading large historical files into memory.

**How to apply:** Compute the digest while importing or in a streaming validation pass, store it on the validated import result, and include only the digest plus safe source metadata in cache keys.