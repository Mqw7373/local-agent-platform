from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class RunRequest(BaseModel):
    projectProfile: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]*$")
    task: str = Field(min_length=1)
    runId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

    @field_validator("task")
    @classmethod
    def task_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("task cannot be blank")
        return value.strip()


class HumanDecision(BaseModel):
    decision: Literal["GO", "NO_GO"]
    confirmedBy: str = Field(min_length=1)
    note: str = ""
    runId: str
    bundleSha256: str
    snapshotSha256: str


class RunAccepted(BaseModel):
    runId: str
    engine: Literal["langgraph"] = "langgraph"
    status: Literal["STARTED", "CONTINUING", "RESUMING"]
    statusUrl: str


class ExecutionCleanupRequest(BaseModel):
    projectProfile: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]*$")
    reason: str = Field(min_length=1)
    confirmedBy: str = Field(min_length=1)


class RecoveryResumeRequest(BaseModel):
    sideEffectStatus: Literal["NONE_OBSERVED", "SIDE_EFFECTS_DETECTED"]
    evidence: list[str] = Field(min_length=1)
    reviewedBy: str = Field(min_length=1)
