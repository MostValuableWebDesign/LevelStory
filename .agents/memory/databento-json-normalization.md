---
name: Databento JSON normalization
description: Non-obvious response conventions for Databento historical JSON and CME futures price fields.
---

Databento historical JSON Lines responses can place timestamp and instrument identity fields inside an `hd` header object while keeping schema-specific fields at the record root. CME futures price fields are fixed-point integers with a 1e9 scale.

**Why:** A successful, authenticated parent-symbology request otherwise appears to contain records but produces zero normalized candles if the adapter reads only top-level timestamps or treats integer prices as dollars.

**How to apply:** Provider normalizers should read both root and `hd` fields, divide price fields by 1e9, and leave unavailable bid/ask values null so Shadow Mode remains quote-gated.