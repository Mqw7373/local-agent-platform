from __future__ import annotations

import hashlib
import json
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .runtime import CodingRuntime


Route = Literal[
    "DOCUMENT_PREFLIGHT",
    "DEVELOP",
    "VERIFY",
    "VERIFICATION_REPAIR",
    "REVIEW",
    "ESCALATE",
    "HUMAN_CONFIRMATION",
    "STOP_DOCUMENT",
    "STOP_CODE",
    "STOP_EXTERNAL",
]


class CodingState(TypedDict, total=False):
    engine: Literal["langgraph"]
    run_id: str
    project_profile: str
    task: str
    route: Route
    objective: str
    bundle: dict[str, Any]
    bundle_sha256: str
    deterministic_preflight: dict[str, Any]
    document_preflight_receipt: dict[str, Any]
    prompt_authority: dict[str, str]
    max_code_cycles: int
    snapshot_sha256: str
    cycle_count: int
    developer_attempt_count: int
    applied_batch_count: int
    work_packages: list[dict[str, Any]]
    work_package_index: int
    summary: str
    developer_result: dict[str, Any]
    verification: dict[str, Any]
    verification_diagnosis: dict[str, Any] | None
    decision: dict[str, Any]
    accepted_p2_ledger: list[dict[str, Any]]
    open_findings: list[dict[str, Any]]
    reviewer_report: dict[str, Any]
    reviewer_decision: dict[str, Any]
    challenger_report: dict[str, Any]
    status: str
    human_decision: dict[str, Any]


def initial_state(project_profile: str, task: str, run_id: str) -> CodingState:
    return {
        "engine": "langgraph",
        "run_id": run_id,
        "project_profile": project_profile,
        "task": task,
        "route": "DOCUMENT_PREFLIGHT",
        "cycle_count": 0,
        "developer_attempt_count": 0,
        "applied_batch_count": 0,
        "work_package_index": 0,
        "summary": "LangGraph run created.",
        "accepted_p2_ledger": [],
        "open_findings": [],
    }


def _accepted_blocking(decision: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not decision:
        return []
    return [
        finding
        for finding in decision.get("findings", [])
        if finding.get("accepted") and finding.get("severity") in {"P0", "P1"}
    ]


def _retain_p2(
    ledger: list[dict[str, Any]], decision: dict[str, Any]
) -> list[dict[str, Any]]:
    retained = {finding["findingId"]: finding for finding in ledger}
    for finding in decision.get("findings", []):
        if finding.get("accepted") and finding.get("severity") == "P2":
            retained.setdefault(finding["findingId"], finding)
    return list(retained.values())


def _route_reviewer_decision(decision: dict[str, Any]) -> Route:
    disposition = decision.get("disposition")
    findings = decision.get("findings", [])
    reasons = decision.get("escalationReasons", [])
    blocking = [
        finding for finding in findings
        if finding.get("accepted") and finding.get("severity") in {"P0", "P1"}
    ]
    roots = {finding.get("rootCause") for finding in blocking}
    if disposition == "ESCALATE":
        if not reasons:
            raise ValueError("Reviewer ESCALATE requires at least one escalation reason.")
        return "ESCALATE"
    if any(not finding.get("accepted") for finding in findings):
        raise ValueError("Direct Reviewer dispositions may contain only accepted authoritative findings.")
    if reasons:
        raise ValueError("Reviewer escalation reasons are only valid for ESCALATE.")
    if disposition == "NO_P0_P1":
        if blocking:
            raise ValueError("NO_P0_P1 cannot contain accepted P0/P1 findings.")
        return "HUMAN_CONFIRMATION"
    if not blocking:
        raise ValueError(f"{disposition} requires at least one accepted P0/P1 finding.")
    if disposition == "DIRECT_CODE_REMEDIATION":
        if roots != {"CODE_DEFECT"}:
            raise ValueError("DIRECT_CODE_REMEDIATION requires only CODE_DEFECT P0/P1 findings.")
        return "DEVELOP"
    if disposition == "DIRECT_DOCUMENT_REVIEW":
        if roots != {"FROZEN_DOCUMENT_DEFECT"}:
            raise ValueError("DIRECT_DOCUMENT_REVIEW requires only FROZEN_DOCUMENT_DEFECT P0/P1 findings.")
        return "STOP_DOCUMENT"
    if disposition == "DIRECT_EXTERNAL_STOP":
        if roots & {"CODE_DEFECT", "FROZEN_DOCUMENT_DEFECT", "INSUFFICIENT_EVIDENCE"}:
            raise ValueError("DIRECT_EXTERNAL_STOP cannot contain code, document, or insufficient-evidence P0/P1 findings.")
        return "STOP_EXTERNAL"
    raise ValueError(f"Unknown Reviewer disposition: {disposition}")


def _seal_reviewer_decision(decision: dict[str, Any], snapshot_sha256: str) -> dict[str, Any]:
    unsealed = {
        "decisionId": "",
        "snapshotSha256": snapshot_sha256,
        "summary": decision["summary"],
        "findings": decision.get("findings", []),
    }
    digest = hashlib.sha256(json.dumps(unsealed, separators=(",", ":")).encode()).hexdigest()
    return {**unsealed, "decisionId": f"REV-{digest[:20]}"}


def _authority(state: CodingState) -> tuple[str, dict[str, Any], str]:
    try:
        return state["objective"], state["bundle"], state["bundle_sha256"]
    except KeyError as error:
        raise RuntimeError("Frozen authority is unavailable after Document Preflight.") from error


def _work_packages(bundle: dict[str, Any], task: str) -> list[dict[str, Any]]:
    configured = bundle.get("work_packages")
    if configured:
        return list(configured)
    return [{
        "id": "WP-FULL-BUNDLE",
        "title": task,
        "acceptanceChecks": list(bundle.get("acceptance_checks", [])),
    }]


def build_graph(runtime: CodingRuntime) -> StateGraph:
    async def assert_current_prompt_authority(state: CodingState) -> None:
        config = await runtime.call("config", projectProfile=state["project_profile"])
        current = config["promptAuthority"]
        bound = state.get("prompt_authority")
        if bound != current:
            raise RuntimeError(
                "PROMPT_AUTHORITY_DRIFT: run is bound to "
                f"{bound or 'unknown'}, but this runtime serves {current}. "
                "Start a new run or use the original runtime."
            )

    async def runtime_preflight(state: CodingState) -> CodingState:
        preflight = await runtime.call("preflight", projectProfile=state["project_profile"])
        config = await runtime.call("config", projectProfile=state["project_profile"])
        result = preflight["result"]
        base: CodingState = {
            "max_code_cycles": config["maxCodeCycles"],
            "prompt_authority": config["promptAuthority"],
            "work_packages": _work_packages(preflight.get("bundle") or {}, state["task"]),
            "work_package_index": 0,
        }
        if (
            result.get("status") != "READY"
            or not result.get("bundleSha256")
            or not preflight.get("objective")
            or not preflight.get("bundle")
        ):
            return {
                **base,
                "route": "STOP_DOCUMENT",
                "summary": result.get("summary", "Frozen Bundle preflight failed."),
                "bundle_sha256": result.get("bundleSha256", ""),
            }
        return {
            **base,
            "route": "DOCUMENT_PREFLIGHT",
            "objective": preflight["objective"],
            "bundle": preflight["bundle"],
            "bundle_sha256": result["bundleSha256"],
            "deterministic_preflight": result,
            "summary": "Deterministic Runtime and Frozen Bundle Preflight passed.",
        }

    async def document_preflight(state: CodingState) -> CodingState:
        objective, bundle, bundle_sha = _authority(state)
        config = await runtime.call("config", projectProfile=state["project_profile"])
        if state.get("prompt_authority") != config["promptAuthority"]:
            raise RuntimeError("PROMPT_AUTHORITY_DRIFT: Document Preflight cannot cross Prompt versions.")
        consistency = await runtime.call(
            "role",
            projectProfile=state["project_profile"],
            runId=state["run_id"],
            role="document-preflight",
            phase="document-preflight",
            input={
                "task": state["task"],
                "frozenObjective": objective,
                "frozenBundle": bundle,
                "configuredDocuments": config["documents"],
                "instruction": (
                    "Read the configured frozen documents and check only material consistency "
                    "and sufficiency for this task."
                ),
            },
        )
        if consistency["status"] == "CONSISTENT" and not consistency.get("issues"):
            receipt = await runtime.call(
                "seal-preflight-receipt",
                projectProfile=state["project_profile"],
                task=state["task"],
                deterministicPreflight=state["deterministic_preflight"],
                independentReview=consistency,
            )
            return {
                "route": "DEVELOP",
                "summary": consistency["summary"],
                "bundle_sha256": bundle_sha,
                "document_preflight_receipt": receipt,
            }
        return {"route": "STOP_DOCUMENT", "summary": consistency["summary"]}

    async def developer(state: CodingState) -> CodingState:
        await assert_current_prompt_authority(state)
        objective, bundle, bundle_sha = _authority(state)
        receipt = state.get("document_preflight_receipt")
        if not receipt:
            raise RuntimeError("Developer dispatch denied: DocumentPreflightReceipt is missing.")
        receipt = await runtime.call(
            "validate-preflight-receipt",
            projectProfile=state["project_profile"],
            task=state["task"],
            bundleSha256=bundle_sha,
            documentPreflightReceipt=receipt,
        )
        cycle_count = state.get("cycle_count", 0)
        attempt_count = state.get("developer_attempt_count", 0) + 1
        applied_batch_count = state.get("applied_batch_count", cycle_count)
        if cycle_count >= state["max_code_cycles"]:
            return {
                "route": "STOP_CODE",
                "summary": f"Reached maxCodeCycles={state['max_code_cycles']} before the next Developer batch.",
                "open_findings": _accepted_blocking(state.get("decision")) + state.get("accepted_p2_ledger", []),
                "developer_attempt_count": state.get("developer_attempt_count", 0),
                "applied_batch_count": applied_batch_count,
            }
        route = state["route"]
        phase = (
            "initial-development"
            if cycle_count == 0
            else "verification-remediation"
            if route == "VERIFICATION_REPAIR"
            else "code-remediation"
        )
        verification_failure = state.get("verification") if route == "VERIFICATION_REPAIR" else None
        decision = state.get("decision")
        work_packages = state.get("work_packages") or _work_packages(bundle, state["task"])
        work_package_index = min(state.get("work_package_index", 0), len(work_packages) - 1)
        work_package = work_packages[work_package_index]
        result = await runtime.call(
            "role",
            projectProfile=state["project_profile"],
            runId=state["run_id"],
            role="developer",
            phase=phase,
            allowedScope=bundle["allowed_scope"],
            input={
                "phase": phase,
                "task": state["task"],
                "objective": objective,
                "frozenBundleSha256": bundle_sha,
                "frozenBundle": bundle,
                "documentPreflightReceipt": receipt,
                "workPackage": work_package,
                "workPackageIndex": work_package_index,
                "workPackageCount": len(work_packages),
                "sealedRemediationDecision": decision,
                "verificationFailure": verification_failure,
                "verificationFailureDiagnosis": (
                    state.get("verification_diagnosis") if verification_failure else None
                ),
                "instruction": (
                    "Repair configured verification failures within frozen and allowed scope; report "
                    "environmental, baseline, documentary, or out-of-scope failures instead of changing unrelated bytes."
                    if verification_failure
                    else "Repair the complete accepted CODE_DEFECT P0/P1 batch. Do not act on unaccepted proposals."
                    if decision
                    else "Implement the task against frozen authority. Inspect the repository before editing."
                ),
            },
        )
        changed_paths = result.get("changedPaths", [])
        remediation_requested = route == "VERIFICATION_REPAIR" or bool(
            [
                finding
                for finding in _accepted_blocking(decision)
                if finding.get("rootCause") == "CODE_DEFECT"
            ]
        )
        if not changed_paths and remediation_requested:
            diagnosis = {
                "classifications": ["EXECUTION_VIOLATION"],
                "developerActionable": False,
                "summary": (
                    "EXECUTION_VIOLATION: Developer returned no changed paths for a required "
                    "remediation batch; the no-op did not consume a Developer cycle."
                ),
                "evidence": ["The validated Developer workspace produced changedPaths=[]."],
            }
            await runtime.call(
                "audit",
                projectProfile=state["project_profile"],
                event={
                    "runId": state["run_id"],
                    "actor": "orchestrator",
                    "action": "developer-no-op-blocked",
                    "phase": phase,
                    "data": diagnosis,
                },
            )
            return {
                "route": "STOP_CODE",
                "cycle_count": cycle_count,
                "developer_attempt_count": attempt_count,
                "applied_batch_count": applied_batch_count,
                "summary": diagnosis["summary"],
                "developer_result": result,
                "verification_diagnosis": diagnosis,
                "open_findings": _accepted_blocking(decision) + state.get("accepted_p2_ledger", []),
            }
        return {
            "route": "VERIFY",
            "cycle_count": cycle_count + (1 if changed_paths else 0),
            "developer_attempt_count": attempt_count,
            "applied_batch_count": applied_batch_count + (1 if changed_paths else 0),
            "summary": (
                result["summary"]
                if changed_paths
                else "Developer returned no changed paths; verification will determine whether the frozen task was already satisfied, and the no-op did not consume a Developer cycle."
            ),
            "developer_result": result,
        }

    async def automated_verification(state: CodingState) -> CodingState:
        verification = await runtime.call("verify", projectProfile=state["project_profile"])
        snapshot = await runtime.call("snapshot", projectProfile=state["project_profile"])
        if verification["passed"]:
            work_packages = state.get("work_packages", [])
            work_package_index = state.get("work_package_index", 0)
            if work_package_index + 1 < len(work_packages):
                return {
                    "route": "DEVELOP",
                    "work_package_index": work_package_index + 1,
                    "snapshot_sha256": snapshot["sha256"],
                    "verification": verification,
                    "verification_diagnosis": None,
                    "summary": (
                        f"Work package {work_packages[work_package_index]['id']} passed verification and was saved; "
                        f"starting {work_packages[work_package_index + 1]['id']}."
                    ),
                }
            return {
                "route": "REVIEW",
                "snapshot_sha256": snapshot["sha256"],
                "verification": verification,
                "verification_diagnosis": None,
                "summary": "Configured automated verification passed.",
            }
        diagnosis = await runtime.call(
            "classify-verification",
            verification=verification,
            changedPaths=state.get("developer_result", {}).get("changedPaths", []),
        )
        await runtime.call(
            "audit",
            projectProfile=state["project_profile"],
            event={
                "runId": state["run_id"],
                "actor": "orchestrator",
                "action": "verification-failure-classified",
                "phase": "automated-verification",
                "data": diagnosis,
            },
        )
        if not diagnosis["developerActionable"]:
            return {
                "route": "STOP_CODE",
                "snapshot_sha256": snapshot["sha256"],
                "verification": verification,
                "verification_diagnosis": diagnosis,
                "summary": diagnosis["summary"],
                "open_findings": _accepted_blocking(state.get("decision"))
                + state.get("accepted_p2_ledger", []),
            }
        if state["cycle_count"] >= state["max_code_cycles"]:
            return {
                "route": "STOP_CODE",
                "snapshot_sha256": snapshot["sha256"],
                "verification": verification,
                "verification_diagnosis": diagnosis,
                "summary": f"Reached maxCodeCycles={state['max_code_cycles']} with automated verification still failing.",
                "open_findings": _accepted_blocking(state.get("decision")) + state.get("accepted_p2_ledger", []),
            }
        return {
            "route": "VERIFICATION_REPAIR",
            "snapshot_sha256": snapshot["sha256"],
            "verification": verification,
            "verification_diagnosis": diagnosis,
            "summary": diagnosis["summary"],
        }

    def review_input(state: CodingState) -> dict[str, Any]:
        objective, _bundle, bundle_sha = _authority(state)
        closure = _accepted_blocking(state.get("decision"))
        return {
            "role": "reviewer",
            "task": state["task"],
            "objective": objective,
            "bundleSha256": bundle_sha,
            "candidateSnapshotSha256": state["snapshot_sha256"],
            "verification": state["verification"],
            "changedPaths": state.get("developer_result", {}).get("changedPaths", []),
            "closureFindings": closure,
            "reviewCycle": state["cycle_count"],
            "instruction": (
                "Check closure of every supplied accepted finding and inspect changed and adjacent reachable paths. "
                "Return one Reviewer Decision; escalate only high-risk, evidence-insufficient, or conflicting conclusions."
                if closure
                else "Perform independent discovery and return one Reviewer Decision. Route clear outcomes directly; escalate only high-risk, evidence-insufficient, or conflicting conclusions."
            ),
        }

    async def reviewer(state: CodingState) -> CodingState:
        await assert_current_prompt_authority(state)
        report = await runtime.call(
            "role",
            projectProfile=state["project_profile"],
            runId=state["run_id"],
            role="reviewer",
            phase="candidate-review",
            input=review_input(state),
        )
        route = _route_reviewer_decision(report)
        if route == "ESCALATE":
            return {
                "route": "ESCALATE",
                "reviewer_report": report,
                "reviewer_decision": report,
                "summary": report["summary"],
            }
        sealed = _seal_reviewer_decision(report, state["snapshot_sha256"])
        accepted_p2 = _retain_p2(state.get("accepted_p2_ledger", []), sealed)
        blocking = _accepted_blocking(sealed)
        summaries = {
            "DEVELOP": "Reviewer found clear code P0/P1 and returned one sealed remediation batch to Developer.",
            "STOP_DOCUMENT": "Reviewer found clear document P0/P1; Document Owner revision, human approval, and a superseding Bundle are required.",
            "STOP_EXTERNAL": "Reviewer found a clear blocking issue requiring baseline, platform, product, or external resolution.",
            "HUMAN_CONFIRMATION": "Automated verification passed and Reviewer found no P0/P1. Human final confirmation is required.",
        }
        return {
            "route": route,
            "reviewer_report": report,
            "reviewer_decision": report,
            "decision": sealed,
            "accepted_p2_ledger": accepted_p2,
            "open_findings": accepted_p2 if route == "HUMAN_CONFIRMATION" else blocking + accepted_p2,
            "summary": summaries[route],
        }

    async def challenger(state: CodingState) -> CodingState:
        if state["route"] != "ESCALATE":
            return {}
        await assert_current_prompt_authority(state)
        try:
            report = await runtime.call(
                "role",
                projectProfile=state["project_profile"],
                runId=state["run_id"],
                role="challenger",
                phase="escalated-challenge",
                input={
                    **review_input(state),
                    "role": "challenger",
                    "reviewerDecision": state["reviewer_decision"],
                    "instruction": (
                        "Use a fresh context to independently investigate the escalated risk or conflict. "
                        "The Reviewer report is evidence, not authority. Return proposals only."
                    ),
                },
            )
            return {"challenger_report": report}
        except RuntimeError as error:
            message = str(error)
            if "PLATFORM_LIMITATION:" not in message:
                raise
            return {"route": "STOP_CODE", "summary": message}

    async def adjudicator(state: CodingState) -> CodingState:
        if state["route"] != "ESCALATE":
            return {}
        await assert_current_prompt_authority(state)
        decision = await runtime.call(
            "role",
            projectProfile=state["project_profile"],
            runId=state["run_id"],
            role="adjudicator",
            phase="candidate-adjudication",
            input={
                "phase": "candidate-adjudication",
                "task": state["task"],
                "reviewCycle": state["cycle_count"],
                "candidateSnapshotSha256": state["snapshot_sha256"],
                "verification": state["verification"],
                "reviewerDecision": state["reviewer_decision"],
                "challengerProposalSet": state["challenger_report"],
                "rule": (
                    "Resolve only the escalated high-risk, evidence-insufficient, or conflicting matter. "
                    "Accept or reject material findings, assign final severity and root cause, preserve P2, "
                    "and produce one complete decision batch."
                ),
            },
        )
        decision = await runtime.call(
            "seal-decision",
            decision=decision,
            snapshotSha256=state["snapshot_sha256"],
        )
        accepted_p2 = _retain_p2(state.get("accepted_p2_ledger", []), decision)
        blocking = _accepted_blocking(decision)
        document_defects = [f for f in blocking if f["rootCause"] == "FROZEN_DOCUMENT_DEFECT"]
        if document_defects:
            return {
                "route": "STOP_DOCUMENT",
                "decision": decision,
                "accepted_p2_ledger": accepted_p2,
                "open_findings": document_defects + accepted_p2,
                "summary": (
                    "Accepted document P0/P1 requires Document Owner revision, human approval, "
                    "and a superseding Bundle."
                ),
            }
        code_defects = [f for f in blocking if f["rootCause"] == "CODE_DEFECT"]
        external = [
            f for f in blocking if f["rootCause"] not in {"CODE_DEFECT", "FROZEN_DOCUMENT_DEFECT"}
        ]
        if external:
            return {
                "route": "STOP_EXTERNAL",
                "decision": decision,
                "accepted_p2_ledger": accepted_p2,
                "open_findings": external + accepted_p2,
                "summary": "Blocking findings require baseline, platform, product, or stronger-evidence resolution outside Developer.",
            }
        if code_defects:
            return {
                "route": "DEVELOP",
                "decision": decision,
                "accepted_p2_ledger": accepted_p2,
                "open_findings": code_defects + accepted_p2,
                "summary": "Accepted code P0/P1 is returning as one sealed batch to Developer.",
            }
        return {
            "route": "HUMAN_CONFIRMATION",
            "decision": decision,
            "accepted_p2_ledger": accepted_p2,
            "open_findings": accepted_p2,
            "summary": "Automated verification passed and no accepted P0/P1 remains. Human final confirmation is required.",
        }

    async def human_final_confirmation(state: CodingState) -> CodingState:
        if state["route"] == "STOP_DOCUMENT":
            return {"status": "NEEDS_DOCUMENT_REVIEW"}
        if state["route"] == "STOP_EXTERNAL":
            return {"status": "NEEDS_EXTERNAL_RESOLUTION"}
        if state["route"] != "HUMAN_CONFIRMATION":
            return {"status": "NEEDS_CODE_REMEDIATION"}
        binding = {
            "status": "AWAITING_HUMAN_FINAL_CONFIRMATION",
            "runId": state["run_id"],
            "bundleSha256": state["bundle_sha256"],
            "snapshotSha256": state["snapshot_sha256"],
            "summary": state["summary"],
        }
        resumed = interrupt(binding)
        expected = (state["run_id"], state["bundle_sha256"], state["snapshot_sha256"])
        supplied = (resumed.get("runId"), resumed.get("bundleSha256"), resumed.get("snapshotSha256"))
        current = await runtime.call("snapshot", projectProfile=state["project_profile"])
        if supplied != expected or current["sha256"] != state["snapshot_sha256"]:
            return {
                "status": "NEEDS_CODE_REMEDIATION",
                "summary": "Human confirmation binding is stale or does not match the current candidate snapshot.",
            }
        decision = resumed.get("decision")
        if decision not in {"GO", "NO_GO"} or not resumed.get("confirmedBy"):
            raise ValueError("Human confirmation requires GO/NO_GO and confirmedBy.")
        await runtime.call(
            "audit",
            projectProfile=state["project_profile"],
            event={
                "runId": state["run_id"],
                "actor": "human",
                "action": "final-confirmation",
                "phase": "final",
                "data": resumed,
            },
        )
        return {
            "status": decision,
            "human_decision": resumed,
            "summary": f"{decision} confirmed by {resumed['confirmedBy']}. {resumed.get('note', '')}".strip(),
        }

    def after_preflight(state: CodingState) -> str:
        return "documents" if state["route"] == "DOCUMENT_PREFLIGHT" else "final"

    def after_document(state: CodingState) -> str:
        return "develop" if state["route"] == "DEVELOP" else "final"

    def after_verification(state: CodingState) -> str:
        if state["route"] in {"DEVELOP", "VERIFICATION_REPAIR"}:
            return "develop"
        if state["route"] == "REVIEW":
            return "reviewer"
        return "final"

    def after_reviewer(state: CodingState) -> str:
        if state["route"] == "ESCALATE":
            return "challenger"
        if state["route"] == "DEVELOP":
            return "develop"
        return "final"

    def after_challenger(state: CodingState) -> str:
        return "adjudicate" if state["route"] == "ESCALATE" else "final"

    def after_adjudication(state: CodingState) -> str:
        return "develop" if state["route"] == "DEVELOP" else "final"

    graph = StateGraph(CodingState)
    graph.add_node("runtime_preflight", runtime_preflight)
    graph.add_node("document_preflight", document_preflight)
    graph.add_node("developer", developer)
    graph.add_node("automated_verification", automated_verification)
    graph.add_node("reviewer", reviewer)
    graph.add_node("challenger", challenger)
    graph.add_node("adjudicator", adjudicator)
    graph.add_node("human_final_confirmation", human_final_confirmation)
    graph.add_edge(START, "runtime_preflight")
    graph.add_conditional_edges(
        "runtime_preflight",
        after_preflight,
        {"documents": "document_preflight", "final": "human_final_confirmation"},
    )
    graph.add_conditional_edges(
        "document_preflight",
        after_document,
        {"develop": "developer", "final": "human_final_confirmation"},
    )
    graph.add_edge("developer", "automated_verification")
    graph.add_conditional_edges(
        "automated_verification",
        after_verification,
        {
            "develop": "developer",
            "reviewer": "reviewer",
            "final": "human_final_confirmation",
        },
    )
    graph.add_conditional_edges(
        "reviewer",
        after_reviewer,
        {"develop": "developer", "challenger": "challenger", "final": "human_final_confirmation"},
    )
    graph.add_conditional_edges(
        "challenger",
        after_challenger,
        {"adjudicate": "adjudicator", "final": "human_final_confirmation"},
    )
    graph.add_conditional_edges(
        "adjudicator",
        after_adjudication,
        {"develop": "developer", "final": "human_final_confirmation"},
    )
    graph.add_edge("human_final_confirmation", END)
    return graph
