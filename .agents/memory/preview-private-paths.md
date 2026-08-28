---
name: Preview private paths
description: Security behavior for SPA previews serving unknown URLs
---
Path-based SPA fallback can turn a request for a protected-looking URL into a successful index-shell response even when no private file is exposed.

**Why:** A 200 shell response makes protected-path verification ambiguous and can hide regressions in the preview server's file boundary.

**How to apply:** Install a dev/preview middleware guard before SPA fallback for encoded private paths, source directories, uploaded assets, CSVs, manifests, metadata, and environment files.