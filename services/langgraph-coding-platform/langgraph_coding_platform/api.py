from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, RedirectResponse
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from .models import ExecutionCleanupRequest, HumanDecision, RecoveryResumeRequest, RunAccepted, RunRequest
from .runtime import RuntimeBridgeError, TypeScriptRuntimeBridge
from .workflow import build_graph, initial_state


def _database_path() -> Path:
    configured = os.environ.get("LANGGRAPH_CODING_DB")
    if configured:
        return Path(configured).expanduser().resolve()
    home = Path(os.environ.get("LOCAL_AGENT_PLATFORM_HOME", Path.home() / ".local-agent-platform"))
    return (home / "state" / "langgraph-coding" / "checkpoints.sqlite").resolve()


def _config(run_id: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": f"langgraph:{run_id}",
        }
    }


def _persist_failures(app: FastAPI) -> None:
    target = Path(app.state.failure_file)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(app.state.failures, indent=2), encoding="utf-8")
    temporary.replace(target)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database = _database_path()
    database.parent.mkdir(parents=True, exist_ok=True)
    runtime = TypeScriptRuntimeBridge()
    async with AsyncSqliteSaver.from_conn_string(str(database)) as checkpointer:
        await checkpointer.setup()
        app.state.graph = build_graph(runtime).compile(
            checkpointer=checkpointer,
            name="langgraph-coding-agent-loop",
        )
        app.state.runtime = runtime
        app.state.tasks: dict[str, asyncio.Task[Any]] = {}
        failure_file = database.with_suffix(database.suffix + ".failures.json")
        try:
            persisted_failures = json.loads(failure_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            persisted_failures = {}
        app.state.failures: dict[str, dict[str, Any]] = persisted_failures
        app.state.failure_file = str(failure_file)
        app.state.database = str(database)
        yield
        active = [task for task in app.state.tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)


app = FastAPI(
    title="LangGraph Coding Platform",
    version="0.1.0",
    description="Parallel LangGraph orchestration over the shared Coding Agent Loop runtime.",
    lifespan=lifespan,
)

_UI_FILE = Path(__file__).resolve().parent / "static" / "index.html"


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse(url="/ui")


@app.get("/ui", include_in_schema=False)
async def visual_console() -> FileResponse:
    return FileResponse(_UI_FILE)


async def _drive(app: FastAPI, run_id: str, command: Any) -> None:
    try:
        app.state.failures.pop(run_id, None)
        _persist_failures(app)
        await app.state.graph.ainvoke(command, _config(run_id))
    except asyncio.CancelledError:
        raise
    except RuntimeBridgeError as error:
        app.state.failures[run_id] = {"message": str(error), **error.details}
        _persist_failures(app)
    except Exception as error:
        app.state.failures[run_id] = {"message": str(error), "code": "UNCLASSIFIED_PLATFORM_FAILURE"}
        _persist_failures(app)


def derive_execution_status(
    *,
    failure: dict[str, Any] | None,
    task_running: bool,
    has_interrupts: bool,
    has_next: bool,
) -> str:
    if failure:
        return "FAILED"
    if task_running:
        return "RUNNING"
    if has_interrupts:
        return "AWAITING_HUMAN_CONFIRMATION"
    if not has_next:
        return "COMPLETE"
    return "PAUSED"


def _start(app: FastAPI, run_id: str, command: Any) -> None:
    existing = app.state.tasks.get(run_id)
    if existing and not existing.done():
        raise HTTPException(status_code=409, detail="This LangGraph run is already active.")
    app.state.tasks[run_id] = asyncio.create_task(_drive(app, run_id, command), name=f"langgraph:{run_id}")


@app.get("/healthz")
async def health(request: Request) -> dict[str, Any]:
    profiles = await request.app.state.runtime.call("list-profiles")
    return {
        "status": "ok",
        "engine": "langgraph",
        "checkpointDatabase": request.app.state.database,
        "promptAuthority": profiles["promptAuthority"],
        "profiles": profiles["profiles"],
    }


@app.get("/graph")
async def graph_description(request: Request) -> dict[str, Any]:
    drawable = request.app.state.graph.get_graph()
    return {
        "engine": "langgraph",
        "name": "langgraph-coding-agent-loop",
        "nodes": list(drawable.nodes),
        "mermaid": drawable.draw_mermaid(),
    }


@app.post("/runs", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_run(body: RunRequest, request: Request) -> RunAccepted:
    run_id = body.runId or str(uuid4())
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if snapshot.values:
        raise HTTPException(status_code=409, detail="A checkpoint already exists for this runId.")
    _start(request.app, run_id, initial_state(body.projectProfile, body.task, run_id))
    return RunAccepted(runId=run_id, status="STARTED", statusUrl=f"/runs/{run_id}")


@app.post("/runs/{run_id}/continue", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def continue_run(run_id: str, request: Request) -> RunAccepted:
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown LangGraph runId.")
    if snapshot.interrupts:
        raise HTTPException(status_code=409, detail="Run is waiting for human confirmation; use /resume.")
    project_profile = snapshot.values.get("project_profile")
    progress = (
        await request.app.state.runtime.call(
            "developer-progress", projectProfile=project_profile, runId=run_id
        )
        if project_profile
        else None
    )
    if request.app.state.failures.get(run_id) or (progress and progress.get("executionStatus") == "FAILED_RECOVERABLE"):
        raise HTTPException(
            status_code=409,
            detail="Failed runs require /recovery assessment before any retry; graph continuation is not a Codex-session resume.",
        )
    if not snapshot.next:
        raise HTTPException(status_code=409, detail="Run is already complete.")
    _start(request.app, run_id, None)
    return RunAccepted(runId=run_id, status="CONTINUING", statusUrl=f"/runs/{run_id}")


@app.post("/runs/{run_id}/resume", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def resume_run(run_id: str, body: HumanDecision, request: Request) -> RunAccepted:
    if body.runId != run_id:
        raise HTTPException(status_code=422, detail="Body runId must match the URL runId.")
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown LangGraph runId.")
    if not snapshot.interrupts:
        raise HTTPException(status_code=409, detail="Run is not waiting for human confirmation.")
    _start(request.app, run_id, Command(resume=body.model_dump()))
    return RunAccepted(runId=run_id, status="RESUMING", statusUrl=f"/runs/{run_id}")


@app.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, Any]:
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if not snapshot.values:
        failure = request.app.state.failures.get(run_id)
        if failure:
            return {"runId": run_id, "engine": "langgraph", "executionStatus": "FAILED", "error": failure.get("message"), "failure": failure}
        raise HTTPException(status_code=404, detail="Unknown LangGraph runId.")
    task = request.app.state.tasks.get(run_id)
    task_running = bool(task and not task.done())
    failure = request.app.state.failures.get(run_id)
    progress = None
    project_profile = snapshot.values.get("project_profile")
    if project_profile:
        try:
            progress = await request.app.state.runtime.call(
                "developer-progress", projectProfile=project_profile, runId=run_id
            )
        except RuntimeBridgeError:
            progress = None
    if not failure and progress and progress.get("executionStatus") == "FAILED_RECOVERABLE":
        progress_failure = progress.get("failure") or {}
        failure = {
            "message": progress_failure.get("directReason", "Retained Developer execution failed."),
            "recoverable": True,
            "executionId": progress.get("executionId"),
            **progress_failure,
        }
    execution_status = derive_execution_status(
        failure=failure,
        task_running=task_running,
        has_interrupts=bool(snapshot.interrupts),
        has_next=bool(snapshot.next),
    )
    return {
        "runId": run_id,
        "engine": "langgraph",
        "executionStatus": execution_status,
        "next": list(snapshot.next),
        "interrupts": [item.value for item in snapshot.interrupts],
        "state": snapshot.values,
        "error": failure.get("message") if failure else None,
        "failure": failure,
        "developerProgress": progress,
    }


@app.get("/runs/{run_id}/recovery")
async def assess_recovery(run_id: str, request: Request) -> dict[str, Any]:
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown LangGraph runId.")
    project_profile = snapshot.values["project_profile"]
    progress = await request.app.state.runtime.call(
        "developer-progress", projectProfile=project_profile, runId=run_id
    )
    if not progress or not progress.get("executionId"):
        raise HTTPException(status_code=404, detail="No retained Developer execution exists for this run.")
    assessment = await request.app.state.runtime.call(
        "assess-developer-recovery",
        projectProfile=project_profile,
        executionId=progress["executionId"],
    )
    return {"runId": run_id, "progress": progress, "assessment": assessment}


@app.post("/runs/{run_id}/recover", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def recover_run(run_id: str, body: RecoveryResumeRequest, request: Request) -> RunAccepted:
    snapshot = await request.app.state.graph.aget_state(_config(run_id))
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown LangGraph runId.")
    project_profile = snapshot.values["project_profile"]
    progress = await request.app.state.runtime.call(
        "developer-progress", projectProfile=project_profile, runId=run_id
    )
    if not progress or not progress.get("executionId"):
        raise HTTPException(status_code=409, detail="No retained Developer execution is available.")
    failure = request.app.state.failures.get(run_id)
    if not failure and progress.get("executionStatus") != "FAILED_RECOVERABLE":
        raise HTTPException(status_code=409, detail="Run is not in FAILED state.")
    execution_id = progress["executionId"]
    await request.app.state.runtime.call(
        "review-developer-side-effects",
        projectProfile=project_profile,
        executionId=execution_id,
        sideEffectReview={
            "status": body.sideEffectStatus,
            "evidence": body.evidence,
            "reviewedBy": body.reviewedBy,
        },
    )
    assessment = await request.app.state.runtime.call(
        "assess-developer-recovery",
        projectProfile=project_profile,
        executionId=execution_id,
    )
    if assessment["decision"] != "RESUME":
        raise HTTPException(
            status_code=409,
            detail={"message": "Retained execution cannot be resumed safely.", "assessment": assessment},
        )
    result = await request.app.state.runtime.call(
        "resume-developer-execution",
        projectProfile=project_profile,
        executionId=execution_id,
    )
    changed_paths = result.get("changedPaths", [])
    current_attempts = snapshot.values.get("developer_attempt_count", 0)
    current_batches = snapshot.values.get("applied_batch_count", snapshot.values.get("cycle_count", 0))
    await request.app.state.graph.aupdate_state(
        _config(run_id),
        {
            "route": "VERIFY",
            "developer_result": result,
            "developer_attempt_count": current_attempts + 2,
            "applied_batch_count": current_batches + (1 if changed_paths else 0),
            "cycle_count": snapshot.values.get("cycle_count", 0) + (1 if changed_paths else 0),
            "summary": "Retained Developer session resumed after recovery assessment; continuing with automated verification.",
        },
        as_node="developer",
    )
    request.app.state.failures.pop(run_id, None)
    _persist_failures(request.app)
    _start(request.app, run_id, None)
    return RunAccepted(runId=run_id, status="CONTINUING", statusUrl=f"/runs/{run_id}")


@app.post("/executions/{execution_id}/cleanup")
async def cleanup_execution(
    execution_id: str,
    body: ExecutionCleanupRequest,
    request: Request,
) -> dict[str, Any]:
    result = await request.app.state.runtime.call(
        "cleanup-developer-execution",
        projectProfile=body.projectProfile,
        executionId=execution_id,
        cleanupApproval={"reason": body.reason, "confirmedBy": body.confirmedBy},
    )
    return {"executionId": execution_id, **result}
