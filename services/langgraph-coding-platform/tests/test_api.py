import time
from pathlib import Path

from fastapi.testclient import TestClient

from langgraph_coding_platform.api import app, derive_execution_status


def test_failed_run_status_overrides_pending_next_node() -> None:
    assert derive_execution_status(
        failure={"message": "boom"},
        task_running=False,
        has_interrupts=False,
        has_next=True,
    ) == "FAILED"


def test_ui_exposes_internal_progress_and_unambiguous_counters() -> None:
    ui = (Path(__file__).resolve().parents[1] / "langgraph_coding_platform" / "static" / "index.html").read_text(encoding="utf-8")
    assert "Execution attempts" in ui
    assert "Applied batches" in ui
    assert "Current operation" in ui
    assert "Remaining timeout" in ui
    assert "Recovery decision" in ui
    assert "ONLY WHEN REVIEWER RETURNS ESCALATE" in ui
    routes = app.openapi()["paths"]
    assert "/runs/{run_id}/recovery" in routes
    assert "/runs/{run_id}/recover" in routes
    assert "/executions/{execution_id}/cleanup" in routes


def test_health_and_graph_expose_conditional_escalation_engine(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LANGGRAPH_CODING_DB", str(tmp_path / "checkpoints.sqlite"))
    with TestClient(app) as client:
        health = client.get("/healthz")
        graph = client.get("/graph")
        console = client.get("/ui")
        created = client.post(
            "/runs",
            json={
                "projectProfile": "example",
                "task": "API checkpoint smoke test; stop at missing Bundle preflight.",
                "runId": "api-checkpoint-smoke",
            },
        )
        run = None
        for _ in range(50):
            run = client.get("/runs/api-checkpoint-smoke")
            if run.status_code == 200 and run.json()["executionStatus"] != "RUNNING":
                break
            time.sleep(0.1)

    assert health.status_code == 200
    assert health.json()["engine"] == "langgraph"
    assert health.json()["promptAuthority"]["revision"] == "TC-SESSION-PROMPT-v2.9"
    assert graph.status_code == 200
    assert "developer" in graph.json()["nodes"]
    assert "challenger" in graph.json()["nodes"]
    assert console.status_code == 200
    assert "LangGraph Coding Console" in console.text
    assert created.status_code == 202
    assert run is not None and run.status_code == 200
    assert run.json()["executionStatus"] == "COMPLETE"
    assert run.json()["state"]["status"] == "NEEDS_DOCUMENT_REVIEW"
