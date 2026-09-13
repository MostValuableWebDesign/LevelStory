---
name: Historical index storage authority
description: How to distinguish the current restart-safe historical index from stale workspace cache artifacts.
---

The historical replay worker must trust only the committed SQLite index under the configured historical-data root, after validating its current manifest schema and importer/schedule versions. Workspace cache files from earlier importer versions may still exist beside it and can be empty, stale, or incompatible.

**Why:** The API can restart without its in-memory index while older JSON or SQLite artifacts remain in the workspace cache. Treating those artifacts as the ready index can produce incorrect availability or bypass current rollover and schema validation.

**How to apply:** When a worker reports that the ready index is missing, inspect the configured persistent root and its committed manifest first. Restore or explicitly regenerate from available uploaded source data; do not silently promote an older cache snapshot. Ensure `LEVELSTORY_HISTORICAL_DATA_DIR` is configured in the shared runtime environment before restart, or the process can create a new empty database under `$HOME/.levelstory/historical-data`.