---
name: Bundled worker paths
description: How to keep worker-thread entrypoints valid after the API is bundled.
---

Worker-thread entrypoints must be resolved relative to the emitted bundle layout, and the built output should be inspected whenever a worker is added or moved.

**Why:** In this workspace the API entrypoint is emitted at `dist/index.mjs`, while nested workers are emitted below `dist/lib/...`; a source-relative URL can leave the parent waiting on an unusable worker and a stale indexing lifecycle.

**How to apply:** Match the `new URL()` path to the built `dist` tree, add startup error handling that transitions the parent operation to a failed state, and verify the actual child process and lifecycle status after restarting the workflow.