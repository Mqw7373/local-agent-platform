# TC Agent Loop v2.6 / v0.7 / R7 Bundle v1

This directory is the durable, append-only publication snapshot approved by the user in turn `01a01d97-9cdb-7f20-bb3b-f162004fc804`.

## Published workflow

```text
Frozen Bundle
→ Lightweight Machine Gate
→ Developer (sole product-write role)
→ automated verification (product-read-only)
→ Reviewer A + Blind Challenger (product-read-only)
→ Adjudicator (product-read-only)
→ CODE_DEFECT: Developer remediation loop
→ Reviewer A Closure + Adjudicator Closure (product-read-only)
→ one Final Fresh Challenger (product-read-only)
→ accepted code finding returns to Developer
→ document defect requires Document Owner + human approval + superseding Bundle
→ Human Final Confirmation
```

Only the Developer may modify product code, tests, migration, configuration or product candidate files. Every other Develop Loop role is product-read-only. Non-Developer product mutation is `UNAUTHORIZED_PRODUCT_WRITE_VIOLATION`.

## Status

- Core v2.6 candidate.2 exact bytes: approved for publication.
- Adapter v0.7 candidate.2 exact bytes: approved for publication.
- R7 Bundle v1: `FROZEN_FOR_IMPLEMENTATION`.
- R7 clean-room task: not launched by this publication action.
- R6 and all earlier candidate/history bytes remain unchanged.

This snapshot must not be overwritten. A future revision must be append-only and cite this snapshot as predecessor.
