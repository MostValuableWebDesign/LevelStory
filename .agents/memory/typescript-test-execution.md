---
name: TypeScript test execution
description: How this pnpm workspace executes source-level TypeScript tests with ESM .js import specifiers.
---

Source-level Node tests must run through the workspace's TypeScript runner rather than direct `node --test`. Direct Node execution can strip TypeScript syntax but does not remap this repository's `.js` ESM specifiers to `.ts` source files.

**Why:** A direct Node test run failed on a missing `.js` module even though the corresponding TypeScript source existed; the workspace runner resolves the source graph correctly.

**How to apply:** Keep the API test script routed through the existing scripts workspace TypeScript runner, and preserve the `.js` specifier convention used by the compiled ESM build.