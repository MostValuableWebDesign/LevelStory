---
name: OpenAPI regeneration restart
description: Vite can retain stale missing-file errors while Orval is cleaning and recreating generated client files.
---

After changing the OpenAPI source, regenerate the clients before consuming their types, then restart the web workflow if Vite reports generated files missing.

**Why:** Orval cleans the generated output directory during code generation, and an already-running Vite process can retain failed HMR module resolutions even after generation completes.

**How to apply:** Treat a post-codegen restart as part of contract changes; verify the regenerated API package and browser console afterward.