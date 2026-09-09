# TC Agent Loop v2.7 / Adapter v0.8 / R8 Bundle v1

This append-only prompt revision removes the separate Final Fresh Challenger and Final Adjudication committee.

The canonical review cycle is:

```text
Developer
→ Automated Verification
→ Reviewer
→ Fresh Clean-room Challenger
→ Adjudicator
```

Every Developer remediation produces a new candidate snapshot and repeats that same review cycle. When verification is green and the Adjudicator has no accepted P0/P1, the workflow proceeds directly to Human Final Confirmation.

The v2.6/v0.7/R7 publication remains immutable historical authority for runs that started under it.

