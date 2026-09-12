---
name: Historical Zstandard import
description: Historical MES uploads support streaming .csv.zst ingestion alongside plain CSV.
---

`.csv.zst` files must be discovered as outright contract sources, hashed from their compressed bytes, and decompressed as a stream before line parsing. Do not route them through the fast whole-file string path.

**Why:** multi-year Databento downloads are large, and requiring manual decompression defeats bounded-memory uploads and makes content identity differ between equivalent upload formats.

**How to apply:** preserve the `.csv.zst` suffix through upload materialization and contract detection; reject other archive formats explicitly.