---
name: Journal schema preservation
description: Non-destructive schema evolution for populated LevelStory journal tables
---

When extending a populated journal table, do not accept a schema tool's suggestion to truncate existing records merely to add a uniqueness constraint. Apply additive columns and a unique index that permits existing null keys, preserving historical manual reviews.

**Why:** The journal contains user-authored review history, and automatic Phase 8 records need deduplication without deleting older records.

**How to apply:** Inspect existing rows before migration; use additive, idempotent development DDL or an equivalent migration path when a push command becomes interactive or destructive.