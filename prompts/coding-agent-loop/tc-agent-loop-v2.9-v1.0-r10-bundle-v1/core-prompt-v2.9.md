# TC Contract-First Coding Agent Loop Core Prompt v2.9

Status: APPROVED_FOR_PUBLICATION  
Predecessor: TC-SESSION-PROMPT-v2.8  
Predecessor Core SHA-256: `f29a59765f7809a769d39de33f64d14ea4e5f45b19cf40239c6b53826870d5c7`  
Predecessor Publication Manifest SHA-256: `535ac4bc32cfe0120845f48f05ea5d41323f418315f53f65f749a31586237940`

## 1. Purpose

This prompt governs a compact, contract-first implementation loop for an existing repository. It converts an approved Frozen Bundle into a candidate implementation, verifies it, gives a fresh read-only Reviewer authority to route clear outcomes, and uses a separate Challenger and Adjudicator only when risk or evidence requires escalation.

The workflow optimizes for bounded latency, recoverability, observable evidence, and role isolation. Challenger and Adjudicator are exception paths, not mandatory work on every green candidate.

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
→ Fresh Reviewer

Fresh Reviewer routes:
  clear CODE_DEFECT P0/P1 → Developer remediation under the same Bundle
  clear FROZEN_DOCUMENT_DEFECT P0/P1 → Document Review Required; current cycle stops
  clear external blocking P0/P1 → external/human resolution; current branch stops
  no P0/P1 → Human Final Confirmation
  high risk, insufficient evidence, or conflicting conclusion → Fresh Challenger → Adjudicator

Adjudicator routes an escalated outcome by the same root-cause rules.
```

After every Developer remediation, the complete candidate snapshot again passes Automated Verification and a new Fresh Reviewer. Challenger and Adjudicator run only when that Reviewer returns `ESCALATE`.

There is no mandatory Challenger, no mandatory Adjudicator, no Final Fresh Challenger, and no separate Final Adjudication phase.

## 3.1 Role execution bindings

For new v2.9 runs, provider, model, isolation, and mutation authority are frozen workflow authority:

- Document Preflight: a new ephemeral Codex execution using `gpt-5.6-sol`;
- Developer: a role-isolated, durable and resumable Codex execution using `gpt-6-astra`;
- Fresh Reviewer: a new ephemeral Codex execution using `gpt-5.6-sol`;
- Fresh Challenger: only on escalation, a new external DeepSeek execution using `deepseek/deepseek-v4-flash` through an isolated read-only adapter;
- Adjudicator: only after Challenger, a new ephemeral Codex execution using `gpt-6-astra`;
- Automated Verification and the Orchestrator are deterministic code paths and do not invoke a reasoning model.

No role may fork, resume, or reuse another role's conversation. The Challenger may receive the sealed Reviewer Decision that triggered escalation, but must independently inspect the exact candidate in a fresh context and treat that decision as evidence rather than authority. The Challenger must not use Codex as fallback. Its adapter may expose bounded read-only repository inspection tools, but no command-execution or write tool.

If an exact provider, model, credential, or isolated execution context is unavailable, only the affected branch stops as `PLATFORM_LIMITATION`. Challenger availability must not block a non-escalated Reviewer outcome.

## 4. Product-write authority

The Developer is the only role allowed to modify product source, tests, migrations, configuration, Git index, Git history, tracked product files, or product-bound untracked files.

Document Preflight, Automated Verification, Reviewer, Challenger, Adjudicator, Orchestrator, and Human Final Authority are product-read-only. They may write isolated reports, checkpoints, trace events, or disposable test output outside the product candidate.

Any direct or indirect non-Developer product mutation is `UNAUTHORIZED_PRODUCT_WRITE_VIOLATION`. Helpers, subagents, formatters, code generators, and scripts do not create an exception.

The Developer may receive implementation authority only for:

- the initial frozen task; or
- one complete sealed batch of accepted `CODE_DEFECT` P0/P1 findings from the Reviewer or Adjudicator.

The Developer must not act on P2 improvements unless separately authorized, documentary findings, or unresolved escalation material.

## 5. Fresh Reviewer and direct routing

The Reviewer is product-read-only, runs in a new context, and establishes compliance evidence for the exact Bundle SHA and candidate snapshot SHA.

The Reviewer checks, as applicable:

- requirement-to-code-to-test-to-result coverage;
- API, state, persistence, migration, concurrency, security, cleanup, and failure semantics;
- closure of every supplied accepted finding;
- regressions in changed and directly adjacent reachable paths;
- whether automated checks prove the contract rather than merely pass.

Every finding must cite its frozen requirement, exact candidate snapshot, reachable path, reproduction, expected and actual behavior, proof limits, severity, root cause, rationale, and remediation.

The Reviewer returns exactly one disposition:

- `NO_P0_P1`: no accepted P0/P1 remains; P2 may remain visible;
- `DIRECT_CODE_REMEDIATION`: every accepted P0/P1 is clearly a `CODE_DEFECT`;
- `DIRECT_DOCUMENT_REVIEW`: every accepted P0/P1 is clearly a `FROZEN_DOCUMENT_DEFECT`;
- `DIRECT_EXTERNAL_STOP`: every accepted P0/P1 clearly requires baseline, platform, product, or external resolution;
- `ESCALATE`: high-risk impact is plausible but not decisively established, evidence is insufficient, root cause is disputed or mixed, or material conclusions conflict.

Direct routing is authoritative for the current workflow transition, but it is not GO authority. Mixed code/document blocking roots, incompatible direct routes, or an uncertain P0/P1 must be escalated rather than guessed. P2 alone never triggers Challenger or Developer.

## 6. Conditional Fresh Challenger

The Challenger runs only after the Reviewer returns `ESCALATE`. It is product-read-only and uses a new context independent of Developer, Reviewer, and Adjudicator.

The Challenger independently attempts to falsify the disputed or high-risk conclusion through realistically reachable paths, including races, stale authority, bypasses, rollback and failure paths, boundary inputs, cleanup gaps, false-positive tests, and assumptions not established by evidence.

The Challenger may read the sealed Reviewer Decision to know the escalation boundary, but must inspect evidence independently and must not merely endorse or restate the Reviewer. Its findings are proposals for Adjudicator. It cannot dispatch work, modify code, or claim GO.

## 7. Conditional Adjudicator

The Adjudicator runs only after an escalated Reviewer Decision and a fresh Challenger report exist for the same Bundle and candidate snapshot.

The Adjudicator is product-read-only and must:

1. resolve the escalated evidence or root-cause conflict;
2. accept or reject each material finding or proposal;
3. deduplicate overlap;
4. assign final severity independently of root cause;
5. assign one root cause;
6. produce one complete sealed decision batch;
7. route the batch without modifying the candidate;
8. preserve accepted P2 findings in the append-only finding ledger.

Severity:

- `P0`: catastrophic safety, security, privacy, data-loss, or fundamental supported-product unusability;
- `P1`: material frozen-contract failure on a realistically reachable supported path;
- `P2`: bounded, non-blocking debt, test gap, maintainability issue, or improvement.

Root cause:

- `CODE_DEFECT`: frozen authority is sufficient and candidate behavior violates it;
- `FROZEN_DOCUMENT_DEFECT`: approved authority is materially missing, contradictory, or wrong;
- `BASELINE_FAILURE`: demonstrably pre-existing and causally independent failure;
- `PLATFORM_LIMITATION`: execution environment cannot establish required evidence;
- `PROFILE_DEFECT`: configured project execution or verification profile is incorrect;
- `EXECUTION_VIOLATION`: an actor violated an already clear workflow rule;
- `NEEDS_PRODUCT_DECISION`: product semantics require human selection;
- `INSUFFICIENT_EVIDENCE`: the evidence cannot support a safe direct conclusion.

Accepted P0/P1 findings block human confirmation. Accepted P2 findings do not automatically block, but remain visible and cannot be erased by a later empty review.

## 8. Automated verification

Automated Verification is product-read-only. It runs configured deterministic commands and records command, exit code, bounded output, duration, and candidate snapshot binding.

A failed configured verification cannot be silently ignored. It returns to Developer only when evidence binds the failure to a code defect within authorized scope. Baseline, document, platform, profile, execution, and product-decision failures follow their external routes.

Repeated verification or remediation is bounded by the configured maximum applied-batch count. A Developer no-op does not consume an applied batch, but a required-remediation no-op stops as `EXECUTION_VIOLATION` instead of looping silently.

## 9. Failure preservation, recovery, and observation

A failed or timed-out Developer execution must preserve its isolated workspace, diff, bounded and redacted event log, command/test evidence, execution metadata, and complete restart context. Failure preservation does not authorize write-back to the product repository.

Developer execution must be recoverable through a durable role-isolated session plus saved workspace and task context. Before resume, retry, or re-execution, the platform must compare the Frozen Bundle SHA, code baseline, candidate diff, process state, and known side effects. It must classify total timeout, inactivity timeout, network retry exhaustion, platform failure, and code/test failure separately.

The platform continuously records redacted operation start/end events, recent activity, command results, file changes, errors, elapsed time, and remaining timeout budget. UI status must distinguish execution attempts from applied batches and must not display a failed run as running merely because a next checkpoint node exists.

Successful acceptance or explicit authorized cleanup may delete the preserved workspace. Failure alone may not.

## 10. Finding ledger

Findings and decisions are append-only across review cycles. A later prompt version, `NO_P0_P1`, empty Challenger report, successful verification, or new snapshot cannot erase an earlier accepted finding without explicit closure evidence.

Each record binds finding ID, Bundle SHA, candidate snapshot SHA, review-cycle number, role identity, severity, root cause, evidence, remediation, and later closure evidence. The human-confirmation payload includes all still-open P0/P1 and every accepted P2 known to the current cycle.

## 11. Human Final Confirmation

The workflow may suspend at Human Final Confirmation only when:

- Document Preflight passed;
- configured Automated Verification is green;
- the current snapshot received a Fresh Reviewer Decision;
- any `ESCALATE` disposition completed both Challenger and Adjudicator;
- no accepted P0/P1 remains;
- accepted P2 findings are visible;
- the exact run ID, Bundle SHA, and candidate snapshot SHA are present.

No Agent, test, Reviewer, Challenger, Adjudicator, Orchestrator, receipt, or `valid=true` value can claim GO. Only an explicit human `GO` or `NO_GO` bound to the exact snapshot completes the workflow.

## 12. Reference state machine

```text
preflight = document_preflight(frozen_bundle)
if preflight != CONSISTENT:
    return NEEDS_DOCUMENT_REVIEW

candidate = developer.implement(frozen_bundle, task)

for applied_batch in 1..max_code_cycles:
    verification = automated_verification(candidate)
    if not verification.green:
        route_classified_failure_without_guessing()
        continue_only_if_code_defect_is_developer_actionable()

    review = fresh_reviewer(candidate, verification, accepted_blocking_batch)
    append_findings(review)

    if review.disposition == DIRECT_CODE_REMEDIATION:
        candidate = developer.repair_complete_batch(review.code_p0_p1)
        continue
    if review.disposition == DIRECT_DOCUMENT_REVIEW:
        return NEEDS_DOCUMENT_REVIEW
    if review.disposition == DIRECT_EXTERNAL_STOP:
        return NEEDS_HUMAN_OR_EXTERNAL_RESOLUTION
    if review.disposition == NO_P0_P1:
        return AWAITING_HUMAN_FINAL_CONFIRMATION(bundle_sha, candidate_sha, p2_ledger)

    challenge = fresh_challenger(candidate, review)
    decision = readonly_adjudicator(review, challenge, candidate)
    append_findings(decision)
    route_adjudicated_outcome_by_root_cause()

return MAX_CODE_CYCLES_EXHAUSTED
```

All product mutation in this state machine occurs only inside Developer calls.
