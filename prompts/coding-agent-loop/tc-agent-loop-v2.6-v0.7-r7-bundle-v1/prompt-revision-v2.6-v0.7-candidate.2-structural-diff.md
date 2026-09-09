# TC Workflow v2.6 / v0.7 Candidate 2 — Structural Diff

Finding: `PF-R7-002-DEVELOPER-ONLY-PRODUCT-WRITE-AUTHORITY`

Core predecessor: `core-prompt-v2.6-candidate.1.md`

Core predecessor SHA-256: `bf110412410a0ba70bbb86017f16bea3ecfdd315edc5917a7b4898a7d8b5a454`

Adapter predecessor: `experiment-adapter-v0.7-candidate.1.md`

Adapter predecessor SHA-256: `7049e9812f7af1a2528ab437e6c50f4c643b40b7100130db3d1e243c50f4472c`

Trigger owner task: `01a0188d-43b4-7660-9ca5-703fe006079a`

Trigger owner turn: `01a01d67-af64-7471-8e21-71dddc4a2147`

Monitored evidence baseline: task `01a01b07-9b1f-7ea1-98e5-7421d55eb622`, cursor `aeaa4c20-1dcf-4420-be1a-d45ddb0ac7ba:147`.

## Preserved

- The candidate.1 latency reduction and root-cause routes;
- one Full Discovery Review pair per Bundle cycle;
- at most one Final Fresh Challenger identity per Bundle cycle;
- same Developer for code remediation;
- human approval for document changes and final GO;
- no new roles, receipts, inventory, manifest builder or external validator.

## Clarified

```diff
 Develop Loop product mutation:
- role bullets separately implied that several review roles were read-only
+ only the Developer identity may create, modify, delete or rename product candidate files
+ every other Develop Loop role is product-read-only
+ indirect writes through helpers, subagents, formatters, generators or scripts are also forbidden
+ non-Developer roles may write only their own minimal reports outside the product candidate
+ isolated ephemeral cache, test output and logs are allowed only outside the candidate snapshot and may not be committed
+ unauthorized product mutation invalidates the candidate and stops the workflow
```

```diff
 Final Fresh Challenger accepted CODE_DEFECT:
- wording could be misread as the Challenger participating in remediation
+ Challenger emits a read-only report
+ Adjudicator accepts/rejects and classifies root cause
+ accepted code findings return as a complete batch to the Developer remediation loop
+ Developer alone modifies product files
+ Reviewer, Adjudicator and Final Challenger perform read-only closure or re-verification
```

## Reviewer / Challenger separation

- Reviewer A builds deterministic `Requirement → Code → Test → Result` conformance evidence.
- Blind or Final Challenger tries to falsify it through adversarial, realistically reachable P0/P1 paths.
- Challenger does not repeat ordinary acceptance, build/style or changed-file checklist work.

## Compatibility

- Product semantics and Bundle schema are unchanged.
- No new gate or committee is introduced.
- R6 and candidate.1 remain immutable.
- Active-round effect: `NO_EFFECT_ON_ACTIVE_ROUND`.
- Publication and R7 launch still require explicit user approval of exact bytes.
