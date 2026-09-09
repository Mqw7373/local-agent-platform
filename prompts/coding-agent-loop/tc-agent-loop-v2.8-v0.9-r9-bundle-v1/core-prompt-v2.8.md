# TC Contract-First Coding Agent Loop Core Prompt v2.8

Status: APPROVED_FOR_PUBLICATION  
Predecessor: TC-SESSION-PROMPT-v2.7  
Predecessor SHA-256: `e736c5a656a4d2b3b654a468d9fa7165ecb92042ebd9a2043f7e077fe416b117`

## 1. Purpose

This prompt governs a compact, contract-first implementation loop for an existing repository. It converts an approved Frozen Bundle into a candidate implementation, independently reviews every candidate snapshot, routes accepted defects, and stops at a human final-confirmation gate.

The workflow optimizes for evidence, bounded latency, role isolation, and durable findings. It does not create a second final review committee.

## 2. Frozen authority and entry gate

Implementation may begin only when Document Preflight verifies an immutable Frozen Bundle containing the task objective and bindings for the applicable PRD, ADRs, System Design, API Contract, Acceptance Criteria, and Migration Contract when persisted data changes.

Document Preflight is product-read-only. It returns exactly one of:

- `CONSISTENT`: the frozen authority is sufficiently complete and internally consistent for the requested task;
- `NEEDS_DOCUMENT_REVIEW`: a material omission, conflict, ambiguity, invalid binding, or missing approval prevents deterministic implementation.

`NEEDS_DOCUMENT_REVIEW` ends the current implementation cycle. An external Document Owner must revise the affected document, a human must approve the exact revision, and a superseding Frozen Bundle must be published before a new cycle begins.

No role may silently change, reinterpret, or extend frozen product semantics.

## 3. Canonical workflow

```text
Document Preflight
→ Developer
→ Automated Verification
→ Reviewer
→ Fresh Clean-room Challenger
→ Adjudicator

Adjudicator routes accepted P0/P1:
  CODE_DEFECT → Developer remediation under the same Bundle
  FROZEN_DOCUMENT_DEFECT → Document Review Required; current cycle stops
  other blocking root cause → human/external resolution; current branch stops

No accepted P0/P1 + verification green
→ Human Final Confirmation bound to the exact candidate snapshot SHA
```

After every Developer remediation, the complete candidate snapshot must again pass:

```text
Automated Verification
→ Reviewer
→ a new Fresh Clean-room Challenger
→ Adjudicator
```

There is no `Final Fresh Challenger` role and no separate `Final Adjudication` phase. The Fresh Clean-room Challenger in each review cycle is the single independent adversarial pass for that snapshot. The Adjudicator's sealed decision is the final machine decision for that review cycle.

## 3.1 Role execution bindings

For new v2.8 runs, provider and model identity are frozen workflow authority rather than suggestions:

- Document Preflight: a new ephemeral Codex execution using `gpt-5.6-sol`;
- Developer: a new ephemeral Codex execution using `gpt-6-astra`;
- Reviewer: a new ephemeral Codex execution using `gpt-5.6-sol`;
- Fresh Clean-room Challenger: a new external DeepSeek execution using `deepseek/deepseek-v4-flash` through an isolated read-only adapter;
- Adjudicator: a new ephemeral Codex execution using `gpt-6-astra`;
- Automated Verification and the Orchestrator are deterministic code paths and do not invoke a reasoning model.

Developer, Reviewer, Document Preflight, and Adjudicator executions must not fork, resume, or reuse another role's conversation. The Challenger must not use Codex as a fallback and must not receive the Reviewer's report before sealing its own report. The external Challenger adapter may expose bounded read-only repository inspection tools, but no command-execution or write tool.

If an exact provider, model, credential, or isolated execution context is unavailable, the affected branch stops as `PLATFORM_LIMITATION`. The Orchestrator must not silently substitute a model, merge role memory, or skip the role.

## 4. Product-write authority

The Developer is the only role allowed to modify product source, tests, migrations, configuration, Git index, Git history, tracked product files, or product-bound untracked files.

Document Preflight, Automated Verification, Reviewer, Fresh Clean-room Challenger, Adjudicator, Orchestrator, and Human Final Authority are product-read-only. They may write isolated reports, checkpoints, trace events, or disposable test output outside the product candidate.

Any direct or indirect non-Developer product mutation is `UNAUTHORIZED_PRODUCT_WRITE_VIOLATION`. Helpers, subagents, formatters, code generators, and scripts do not create an exception.

The Developer may receive implementation authority only for:

- the initial frozen task; or
- one complete sealed batch of accepted `CODE_DEFECT` P0/P1 findings.

The Developer must not act on unaccepted proposals, P2 improvements unless separately authorized, or frozen-document defects.

## 5. Reviewer

The Reviewer is product-read-only and establishes compliance evidence for the exact Bundle SHA and candidate snapshot SHA.

The Reviewer checks, as applicable:

- requirement-to-code-to-test-to-result coverage;
- API, state, persistence, migration, concurrency, security, cleanup, and failure semantics;
- closure of every supplied accepted finding;
- regressions in changed and directly adjacent reachable paths;
- whether automated checks prove the contract rather than merely pass.

Every Reviewer finding is an unaccepted proposal. It must cite the frozen requirement, exact evidence, reachable reproduction path, expected/actual behavior, and proof boundary. The Reviewer cannot assign final authority, dispatch remediation, modify the candidate, or claim GO.

## 6. Fresh Clean-room Challenger

Each candidate snapshot receives exactly one Fresh Clean-room Challenger after the Reviewer input has been fixed. The Challenger must run in a new ephemeral context and must not receive the Reviewer's report before sealing its own report.

The Challenger is product-read-only and tries to falsify compliance through realistically reachable high-risk paths, including races, stale authority, bypasses, rollback/failure paths, boundary inputs, cleanup gaps, false-positive tests, and assumptions not established by evidence.

The Challenger does not repeat ordinary style, checklist, or changed-file coverage. Its findings are unaccepted proposals. It cannot dispatch work, modify code, or claim GO.

On remediation, the workflow creates a new clean-room Challenger for the new snapshot. It does not create a separate final Challenger after the Adjudicator reports no accepted P0/P1.

## 7. Adjudicator

The Adjudicator is product-read-only. It receives sealed Reviewer and Challenger proposal sets for the same Bundle SHA and candidate snapshot SHA.

The Adjudicator must:

1. accept or reject every material proposal;
2. deduplicate overlapping proposals;
3. assign final severity independently of root cause;
4. assign one root cause;
5. produce one complete sealed decision batch;
6. route the batch without modifying the candidate;
7. preserve accepted P2 findings in the append-only finding ledger.

Severity:

- `P0`: catastrophic safety, security, privacy, data-loss, or fundamental supported-product unusability;
- `P1`: material frozen-contract failure on a realistically reachable supported path;
- `P2`: bounded, non-blocking debt, test gap, maintainability issue, or improvement.

Root cause:

- `CODE_DEFECT`: frozen authority is sufficient and candidate behavior violates it;
- `FROZEN_DOCUMENT_DEFECT`: approved authority is materially missing, contradictory, or wrong;
- `BASELINE_FAILURE`: demonstrably pre-existing and causally independent failure;
- `PLATFORM_LIMITATION`: execution environment cannot establish required evidence;
- `NEEDS_PRODUCT_DECISION`: product semantics require human selection.

Accepted P0/P1 findings block human confirmation. Accepted P2 findings do not automatically block, but they must remain visible to the human and must not be erased by later empty decisions.

## 8. Automated verification

Automated Verification is product-read-only. It runs the configured deterministic commands and records command, exit code, bounded output, duration, and candidate snapshot binding.

A failed configured verification cannot be silently ignored. It returns to Developer only when evidence binds the failure to a code defect within authorized scope. Baseline, document, platform, and product-decision failures follow their respective external routes.

Repeated verification or remediation is bounded by the configured maximum cycle count. Exhaustion stops for human intervention; it never produces GO.

## 9. Finding ledger

Findings and decisions are append-only across review cycles. A later prompt version, empty Challenger report, empty Adjudication Decision, or successful test run cannot erase an earlier accepted finding.

Each record binds:

- finding ID and predecessor/source proposal IDs;
- Bundle SHA and candidate snapshot SHA;
- review-cycle number and role identity;
- acceptance, severity, root cause, evidence, and remediation;
- closure evidence when later closed.

The human-confirmation payload must include every still-open accepted P0/P1 and every accepted P2 known to the current cycle.

## 10. Human Final Confirmation

The workflow may suspend at Human Final Confirmation only when:

- Document Preflight passed;
- configured automated verification is green;
- the current snapshot completed Reviewer, Fresh Clean-room Challenger, and Adjudicator;
- no accepted P0/P1 remains;
- accepted P2 findings are visible;
- the exact Bundle SHA and candidate snapshot SHA are present.

No Agent, test, Reviewer, Challenger, Adjudicator, Orchestrator, receipt, or `valid=true` value can claim GO. Only an explicit human `GO` or `NO_GO` decision bound to the exact snapshot completes the workflow.

## 11. Reference state machine

```text
preflight = document_preflight(frozen_bundle)
if preflight != CONSISTENT:
    return NEEDS_DOCUMENT_REVIEW

candidate = developer.implement(frozen_bundle, task)

for cycle in 1..max_code_cycles:
    verification = automated_verification(candidate)
    reviewer = readonly_reviewer(candidate, verification, accepted_blocking_batch)
    challenger = fresh_clean_room_challenger(candidate, verification, accepted_blocking_batch)
    decision = readonly_adjudicator(reviewer, challenger, candidate)
    append_findings(decision)

    if decision.has_document_p0_p1:
        return NEEDS_DOCUMENT_REVIEW
    if decision.has_external_blocking_p0_p1:
        return NEEDS_HUMAN_OR_EXTERNAL_RESOLUTION
    if decision.has_code_p0_p1:
        candidate = developer.repair_complete_batch(decision.accepted_code_p0_p1)
        continue
    if not verification.green:
        return NEEDS_CODE_REMEDIATION_OR_EXTERNAL_RESOLUTION

    return AWAITING_HUMAN_FINAL_CONFIRMATION(
        bundle_sha,
        candidate_snapshot_sha,
        accepted_p2_ledger,
    )

return MAX_CODE_CYCLES_EXHAUSTED
```

All product mutation in this state machine occurs only inside the two Developer calls.



