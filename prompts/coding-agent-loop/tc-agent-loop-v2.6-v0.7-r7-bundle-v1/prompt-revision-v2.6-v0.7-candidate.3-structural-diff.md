# TC Workflow v2.6 / v0.7 Candidate 3 — Structural Diff

Findings:

- `PF-R7-003-REVIEWER-PROPOSAL-ONLY`
- `PF-R7-004-MANDATORY-ADJUDICATION-DISPATCH-GATE`
- `PF-R7-005-BASELINE-FAILURE-SEPARATION`

Core predecessor: `core-prompt-v2.6-candidate.2.md`

Core predecessor SHA-256: `39d4b97ff1732c1fb21da6f3a77dbe43138b2402edb827fec3f04734676e404d`

Trigger: a Reviewer Closure report described proposed findings as `accepted P1` and the Orchestrator returned them directly to the Developer without the mandatory same-Adjudicator closure.

## Preserved

- Candidate.2 Developer-only product-write authority;
- one Full Discovery Review pair per Bundle cycle;
- one Final Fresh Challenger identity per Bundle cycle;
- same Developer for adjudicated code remediation;
- same Reviewer A and same Adjudicator for closure;
- human approval for frozen-document changes and final GO;
- existing Bundle, product semantics, acceptance criteria and role count.

## Clarified: proposal versus disposition

```diff
 Reviewer-family output:
- finding_id + severity + classification could be mistaken for a final disposition
+ finding_status = PROPOSED_UNADJUDICATED
+ proposed_severity + proposed_classification
+ Reviewer-family roles cannot use ACCEPTED/REJECTED/DOWNGRADED/MERGED dispositions
+ Reviewer-family roles cannot announce candidate PASS/FAIL/NOT_ACCEPTED or route remediation

 Adjudicator output:
+ exclusively accepts/rejects findings
+ exclusively sets final severity, final classification, root cause and route
```

## Added: mandatory dispatch gate

```diff
 Developer remediation authorization:
- orchestration could treat Reviewer prose or proposed P1 as an accepted remediation batch
+ only a sealed, hash-bound Adjudication Decision can dispatch Developer
+ every dispatched finding ID must appear in accepted_code_P0_P1_ids[]
+ missing or mismatched decision blocks as BLOCKED_UNADJUDICATED_FINDING_DISPATCH
```

## Bounded closure

- Closure recommendations are `CLOSED_RECOMMENDED` or `OPEN_RECOMMENDED` against already adjudicated IDs.
- A remediation-introduced issue is `NEW_UNADJUDICATED` and must bind the changed path to a prior accepted finding.
- A pre-existing missed path is `PRE_EXISTING_DISCOVERY_ESCAPE`.
- Every new finding returns to the same Adjudicator before any Developer dispatch.
- Closure cannot restart unbounded full-product discovery.

## Exact requirement binding

- Proposed P0/P1 findings must quote an exact frozen document SHA, section/line and normative sentence.
- Broad goals such as `production ready`, `durable` or `real integration` cannot alone create a new composition root, CLI auto-wiring, provider construction, lease, schema or endpoint obligation.
- Conflicting interpretations are `CONTRACT_INTERPRETATION_CONFLICT` until adjudicated.

## Baseline failure separation

- A regression that fails identically on the exact baseline, whose causal path is untouched and outside allowed scope, is `PRE_EXISTING_BASELINE_DEFECT`.
- It blocks on `BLOCKED_BASELINE_PRECONDITION`, but is not counted as a candidate code P0/P1 and is not routed to the current Developer.

## Compatibility and authority

- Product requirements and Bundle schema are unchanged.
- No new role, committee or product-write authority is introduced.
- Candidate.2 and the published R7 bundle remain immutable and active.
- Candidate.3 has `NO_EFFECT_ON_ACTIVE_ROUND` until exact bytes receive human approval and are published through a superseding artifact.
