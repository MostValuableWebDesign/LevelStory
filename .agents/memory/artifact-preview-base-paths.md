---
name: Artifact preview base paths
description: The relationship between artifact manifests, Vite base paths, and proxied preview asset requests.
---

The Vite build and managed preview workflow must use the `BASE_PATH` declared by the artifact manifest. A manually overridden base path can generate an HTML shell whose asset URLs do not match the proxy route, producing a visually blank preview even though the build succeeds.

**Why:** The preview proxy routes the registered artifact path independently from the Vite public base, so a mismatch causes stylesheet and script requests to fall through to the SPA shell.

**How to apply:** When verifying an artifact, prefer restarting its managed workflow over manually rebuilding with a guessed `BASE_PATH`; inspect the artifact manifest if the preview is blank.