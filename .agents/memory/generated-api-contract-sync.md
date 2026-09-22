---
name: Generated API contract synchronization
description: Domain union additions must update the OpenAPI source and regenerate every derived client/parser before response validation.
---

When a response can contain a newly introduced domain-union value, update the OpenAPI enum first and regenerate the generated Zod/client artifacts in the same change. Otherwise producers can complete successfully while the status/read endpoint rejects the persisted payload and clients appear to reset or lose progress.

**Why:** A completed Visual Review generation containing new target-skip reasons was returned as HTTP 500 by the generated response parser, so the frontend treated the completed job as unavailable.

**How to apply:** Search both handwritten unions and generated enum schemas after adding a value; run the API codegen command, then test the completed response path rather than only the producer.