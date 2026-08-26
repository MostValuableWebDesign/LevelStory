---
name: OpenAPI numeric validation
description: Compatibility note for OpenAPI codegen and the workspace's installed Zod runtime.
---

OpenAPI `integer` fields currently generate `zod.int()`, but the installed Zod runtime is on the v3 API and does not expose that function. For contracts that need generated Zod validation to compile, represent integer-like values as `number` in OpenAPI and enforce minimum/maximum bounds there; keep database columns strongly typed where appropriate.

**Why:** Codegen succeeds but the chained library typecheck fails when generated schemas call an unavailable Zod method.

**How to apply:** Before adding integer fields to a new OpenAPI contract, confirm the installed Zod major/version and generated output; prefer numeric schemas until the workspace runtime is upgraded consistently.