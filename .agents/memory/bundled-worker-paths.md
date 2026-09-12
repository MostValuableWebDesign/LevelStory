---
name: Bundled worker paths
description: How to keep worker-thread entrypoints valid after the API is bundled.
---

Worker-thread entrypoints must be resolved relative to the emitted bundle layout, and the bundler entrypoint list must be kept in sync whenever a worker is added or removed.

**Why:** In this workspace the API entrypoint is emitted at `dist/index.mjs`, while nested workers are emitted below `dist/lib/...`; a source-relative URL can leave the parent waiting on an unusable worker and a stale indexing lifecycle.

**How to apply:** Match the `new URL()` path to the built `dist` tree, remove deleted workers from build entrypoints, add startup error handling that transitions the parent operation to a failed state, and verify the actual child process and lifecycle status after restarting the workflow.