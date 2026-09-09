from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from langgraph_coding_platform.workflow import build_graph, initial_state


SNAPSHOT = "a" * 64
BUNDLE_SHA = "b" * 64


def finding(
    finding_id: str,
    severity: str,
    root_cause: str,
    *,
    accepted: bool = True,
) -> dict[str, Any]:
    return {
        "findingId": finding_id,
        "sourceProposalIds": [f"proposal-{finding_id}"],
        "accepted": accepted,
        "severity": severity,
        "rootCause": root_cause,
        "rationale": "test rationale",
        "remediation": "test remediation",
    }


class FakeRuntime:
    def __init__(
        self,
        *,
        decisions: list[list[dict[str, Any]]] | None = None,
        reviewer_decisions: list[dict[str, Any]] | None = None,
        verification_results: list[bool] | None = None,
        developer_changed_paths: list[list[str]] | None = None,
        document_status: str = "CONSISTENT",
        challenger_platform_failure: bool = False,
        prompt_authorities: list[dict[str, str]] | None = None,
    ) -> None:
        self.decisions = decisions or [[]]
        self.reviewer_decisions = reviewer_decisions or [{
            "disposition": "NO_P0_P1",
            "summary": "reviewer found no blocking issue",
            "findings": [],
            "escalationReasons": [],
        }]
        self.verification_results = verification_results or [True]
        self.developer_changed_paths = developer_changed_paths or [["src/example.py"]]
        self.document_status = document_status
        self.challenger_platform_failure = challenger_platform_failure
        self.prompt_authorities = prompt_authorities or [{"revision": "v2.9", "sha256": "c" * 64}]
        self.config_calls = 0
        self.developer_calls = 0
        self.verification_calls = 0
        self.adjudicator_calls = 0
        self.reviewer_calls = 0
        self.role_calls: list[str] = []
        self.developer_payloads: list[dict[str, Any]] = []

    async def call(self, operation: str, **payload: Any) -> Any:
        if operation == "preflight":
            return {
                "result": {
                    "status": "READY",
                    "bundleSha256": BUNDLE_SHA,
                    "summary": "ready",
                    "issues": [],
                },
                "objective": "Implement the test task",
                "bundle": {
                    "allowed_scope": ["src/**", "tests/**"],
                    "documents": [],
                    "acceptance_checks": ["package one", "package two"],
                    "work_packages": [
                        {"id": "WP-1", "title": "first", "acceptanceChecks": ["package one"]},
                        {"id": "WP-2", "title": "second", "acceptanceChecks": ["package two"]},
                    ],
                },
            }
        if operation == "config":
            index = min(self.config_calls, len(self.prompt_authorities) - 1)
            prompt_authority = deepcopy(self.prompt_authorities[index])
            self.config_calls += 1
            return {
                "maxCodeCycles": 4,
                "documents": {},
                "promptAuthority": prompt_authority,
            }
        if operation == "seal-preflight-receipt":
            return {
                "receiptVersion": "1",
                "receiptId": "DPF-" + "d" * 20,
                "projectProfile": payload["projectProfile"],
                "taskSha256": "e" * 64,
                "bundleSha256": BUNDLE_SHA,
                "deterministic": {
                    "status": "READY",
                    "summary": "ready",
                    "issues": [],
                },
                "independentReview": deepcopy(payload["independentReview"]),
            }
        if operation == "validate-preflight-receipt":
            assert payload["bundleSha256"] == BUNDLE_SHA
            return deepcopy(payload["documentPreflightReceipt"])
        if operation == "verify":
            index = min(self.verification_calls, len(self.verification_results) - 1)
            passed = self.verification_results[index]
            self.verification_calls += 1
            return {"passed": passed, "commands": []}
        if operation == "classify-verification":
            if payload.get("changedPaths"):
                return {
                    "classifications": ["CODE_DEFECT"],
                    "developerActionable": True,
                    "summary": "code failure",
                    "evidence": ["bound to diff"],
                }
            return {
                "classifications": ["EXECUTION_VIOLATION", "BASELINE_FAILURE"],
                "developerActionable": False,
                "summary": "external no-op baseline failure",
                "evidence": ["unchanged candidate"],
            }
        if operation == "snapshot":
            return {"sha256": SNAPSHOT, "files": 3}
        if operation == "seal-decision":
            decision = deepcopy(payload["decision"])
            decision["decisionId"] = f"ADJ-{self.adjudicator_calls:03d}"
            decision["snapshotSha256"] = payload["snapshotSha256"]
            return decision
        if operation == "audit":
            return {"recorded": True}
        if operation != "role":
            raise AssertionError(f"Unexpected operation: {operation}")
        role = payload["role"]
        self.role_calls.append(role)
        if role == "document-preflight":
            return {"status": self.document_status, "summary": "document result", "issues": []}
        if role == "developer":
            self.developer_payloads.append(deepcopy(payload))
            index = min(self.developer_calls, len(self.developer_changed_paths) - 1)
            changed_paths = self.developer_changed_paths[index]
            self.developer_calls += 1
            return {
                "summary": "developer result",
                "changedPaths": changed_paths,
                "testsAddedOrChanged": ["tests/test_example.py"] if changed_paths else [],
                "unresolved": [],
            }
        if role == "reviewer":
            index = min(self.reviewer_calls, len(self.reviewer_decisions) - 1)
            selected = deepcopy(self.reviewer_decisions[index])
            self.reviewer_calls += 1
            return selected
        if role == "challenger":
            if self.challenger_platform_failure:
                raise RuntimeError("PLATFORM_LIMITATION: missing Challenger provider credentials")
            return {"summary": "challenger result", "proposals": []}
        if role == "adjudicator":
            index = min(self.adjudicator_calls, len(self.decisions) - 1)
            selected = deepcopy(self.decisions[index])
            self.adjudicator_calls += 1
            return {
                "decisionId": "unsealed",
                "snapshotSha256": SNAPSHOT,
                "summary": "adjudicated",
                "findings": selected,
            }
        raise AssertionError(f"Unexpected role: {role}")


def config(run_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": f"langgraph:{run_id}"}}


@pytest.mark.asyncio
async def test_green_candidate_reaches_bound_human_confirmation() -> None:
    runtime = FakeRuntime()
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "green-run"
    await graph.ainvoke(initial_state("example", "test task", run_id), config(run_id))
    snapshot = await graph.aget_state(config(run_id))

    assert runtime.developer_calls == 2
    developer_input = runtime.developer_payloads[0]["input"]
    assert developer_input["frozenBundleSha256"] == BUNDLE_SHA
    assert developer_input["documentPreflightReceipt"]["bundleSha256"] == BUNDLE_SHA
    assert developer_input["documentPreflightReceipt"]["independentReview"]["status"] == "CONSISTENT"
    assert runtime.role_calls.count("reviewer") == 1
    assert runtime.role_calls.count("challenger") == 0
    assert runtime.adjudicator_calls == 0
    assert snapshot.values["developer_attempt_count"] == 2
    assert snapshot.values["applied_batch_count"] == 2
    assert [payload["input"]["workPackage"]["id"] for payload in runtime.developer_payloads] == ["WP-1", "WP-2"]
    assert snapshot.interrupts[0].value == {
        "status": "AWAITING_HUMAN_FINAL_CONFIRMATION",
        "runId": run_id,
        "bundleSha256": BUNDLE_SHA,
        "snapshotSha256": SNAPSHOT,
        "summary": snapshot.values["summary"],
    }

    await graph.ainvoke(
        Command(
            resume={
                "decision": "GO",
                "confirmedBy": "Tester",
                "note": "approved",
                "runId": run_id,
                "bundleSha256": BUNDLE_SHA,
                "snapshotSha256": SNAPSHOT,
            }
        ),
        config(run_id),
    )
    final = await graph.aget_state(config(run_id))
    assert final.values["status"] == "GO"
    assert not final.next


@pytest.mark.asyncio
async def test_verification_and_code_findings_loop_only_to_developer() -> None:
    p2 = finding("P2-KEEP", "P2", "CODE_DEFECT")
    code_p1 = finding("P1-FIX", "P1", "CODE_DEFECT")
    runtime = FakeRuntime(
        verification_results=[False, True, True],
        reviewer_decisions=[
            {
                "disposition": "DIRECT_CODE_REMEDIATION",
                "summary": "clear code P1",
                "findings": [p2, code_p1],
                "escalationReasons": [],
            },
            {
                "disposition": "NO_P0_P1",
                "summary": "closed",
                "findings": [],
                "escalationReasons": [],
            },
        ],
    )
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "repair-run"
    await graph.ainvoke(initial_state("example", "repair task", run_id), config(run_id))
    snapshot = await graph.aget_state(config(run_id))

    assert runtime.developer_calls == 4
    assert runtime.role_calls.count("challenger") == 0
    assert runtime.adjudicator_calls == 0
    assert [item["findingId"] for item in snapshot.values["accepted_p2_ledger"]] == ["P2-KEEP"]
    assert snapshot.values["route"] == "HUMAN_CONFIRMATION"


@pytest.mark.asyncio
async def test_document_p1_stops_without_second_developer_cycle() -> None:
    runtime = FakeRuntime(reviewer_decisions=[{
        "disposition": "DIRECT_DOCUMENT_REVIEW",
        "summary": "clear document P1",
        "findings": [finding("DOC-P1", "P1", "FROZEN_DOCUMENT_DEFECT")],
        "escalationReasons": [],
    }])
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "document-stop"
    result = await graph.ainvoke(initial_state("example", "document task", run_id), config(run_id))

    assert runtime.developer_calls == 2
    assert result["status"] == "NEEDS_DOCUMENT_REVIEW"
    assert result["route"] == "STOP_DOCUMENT"


@pytest.mark.asyncio
async def test_clear_external_p1_stops_without_challenger() -> None:
    runtime = FakeRuntime(reviewer_decisions=[{
        "disposition": "DIRECT_EXTERNAL_STOP",
        "summary": "clear profile defect",
        "findings": [finding("PROFILE-P1", "P1", "PROFILE_DEFECT")],
        "escalationReasons": [],
    }])
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "external-stop"
    result = await graph.ainvoke(initial_state("example", "external task", run_id), config(run_id))

    assert runtime.role_calls.count("challenger") == 0
    assert runtime.adjudicator_calls == 0
    assert result["status"] == "NEEDS_EXTERNAL_RESOLUTION"
    assert result["route"] == "STOP_EXTERNAL"


@pytest.mark.asyncio
async def test_document_preflight_failure_never_enters_developer() -> None:
    runtime = FakeRuntime(document_status="NEEDS_DOCUMENT_REVIEW")
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "preflight-stop"
    result = await graph.ainvoke(initial_state("example", "blocked task", run_id), config(run_id))

    assert runtime.developer_calls == 0
    assert result["status"] == "NEEDS_DOCUMENT_REVIEW"


@pytest.mark.asyncio
async def test_prompt_authority_drift_cannot_cross_into_a_role() -> None:
    runtime = FakeRuntime(prompt_authorities=[
        {"revision": "v2.8", "sha256": "8" * 64},
        {"revision": "v2.9", "sha256": "9" * 64},
    ])
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "prompt-drift"

    with pytest.raises(RuntimeError, match="PROMPT_AUTHORITY_DRIFT"):
        await graph.ainvoke(initial_state("example", "old bound task", run_id), config(run_id))
    assert runtime.developer_calls == 0


@pytest.mark.asyncio
async def test_challenger_provider_is_irrelevant_without_escalation() -> None:
    runtime = FakeRuntime(challenger_platform_failure=True)
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "challenger-platform-stop"
    result = await graph.ainvoke(initial_state("example", "test task", run_id), config(run_id))

    assert runtime.developer_calls == 2
    assert runtime.role_calls.count("challenger") == 0
    assert runtime.adjudicator_calls == 0
    assert result["route"] == "HUMAN_CONFIRMATION"


@pytest.mark.asyncio
async def test_escalation_alone_invokes_challenger_and_adjudicator() -> None:
    runtime = FakeRuntime(
        reviewer_decisions=[{
            "disposition": "ESCALATE",
            "summary": "high-risk evidence conflict",
            "findings": [],
            "escalationReasons": ["Reachability evidence conflicts with the verification trace."],
        }],
        decisions=[[]],
    )
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "escalation-run"
    await graph.ainvoke(initial_state("example", "test task", run_id), config(run_id))
    snapshot = await graph.aget_state(config(run_id))

    assert runtime.role_calls.count("reviewer") == 1
    assert runtime.role_calls.count("challenger") == 1
    assert runtime.adjudicator_calls == 1
    assert snapshot.values["route"] == "HUMAN_CONFIRMATION"


@pytest.mark.asyncio
async def test_challenger_platform_limitation_stops_only_escalation_branch() -> None:
    runtime = FakeRuntime(
        reviewer_decisions=[{
            "disposition": "ESCALATE",
            "summary": "needs independent challenge",
            "findings": [],
            "escalationReasons": ["High-risk path lacks decisive evidence."],
        }],
        challenger_platform_failure=True,
    )
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "challenger-platform-stop"
    result = await graph.ainvoke(initial_state("example", "test task", run_id), config(run_id))

    assert runtime.role_calls.count("challenger") == 1
    assert runtime.adjudicator_calls == 0
    assert result["status"] == "NEEDS_CODE_REMEDIATION"
    assert "PLATFORM_LIMITATION:" in result["summary"]


@pytest.mark.asyncio
async def test_initial_no_op_does_not_exhaust_developer_cycles() -> None:
    runtime = FakeRuntime(
        verification_results=[False, False, False],
        developer_changed_paths=[[], [], []],
    )
    graph = build_graph(runtime).compile(checkpointer=InMemorySaver())
    run_id = "no-op-stop"
    result = await graph.ainvoke(initial_state("example", "implementation required", run_id), config(run_id))

    assert runtime.developer_calls == 1
    assert runtime.verification_calls == 1
    assert result["cycle_count"] == 0
    assert result["developer_attempt_count"] == 1
    assert result["route"] == "STOP_CODE"
    assert result["verification_diagnosis"]["developerActionable"] is False
    assert "EXECUTION_VIOLATION" in result["verification_diagnosis"]["classifications"]
