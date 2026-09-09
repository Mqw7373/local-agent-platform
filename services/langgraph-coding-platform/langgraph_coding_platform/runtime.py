from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Protocol


class CodingRuntime(Protocol):
    async def call(self, operation: str, **payload: Any) -> Any: ...


class RuntimeBridgeError(RuntimeError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


class TypeScriptRuntimeBridge:
    """Calls the existing TypeScript runtime so both engines enforce identical write rules."""

    def __init__(self, mastra_service: Path | None = None) -> None:
        service_root = Path(__file__).resolve().parents[1]
        self.mastra_service = (mastra_service or service_root.parent / "mastra-coding-platform").resolve()
        executable = "tsx.cmd" if os.name == "nt" else "tsx"
        self.tsx = self.mastra_service / "node_modules" / ".bin" / executable
        self.bridge = self.mastra_service / "scripts" / "langgraph-runtime-bridge.ts"
        configured_registry = os.environ.get("CODING_AGENT_PROFILES")
        local_registry = self.mastra_service / "coding-agent.profiles.json"
        example_registry = self.mastra_service / "coding-agent.profiles.example.json"
        self.registry = (
            Path(configured_registry).resolve()
            if configured_registry
            else local_registry
            if local_registry.is_file()
            else example_registry
        )

    async def call(self, operation: str, **payload: Any) -> Any:
        if not self.tsx.is_file():
            raise RuntimeBridgeError(
                f"Mastra runtime dependencies are missing at {self.tsx}. Run npm install in {self.mastra_service}."
            )
        request = {"operation": operation, **payload}
        environment = {
            **os.environ,
            "CODING_AGENT_PROFILES": str(self.registry),
            "CODING_ORCHESTRATOR_ENGINE": "langgraph",
        }
        process = await asyncio.create_subprocess_exec(
            str(self.tsx),
            str(self.bridge),
            cwd=str(self.mastra_service),
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(json.dumps(request).encode("utf-8"))
        try:
            envelope = json.loads(stdout.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeBridgeError(
                f"Runtime bridge returned invalid JSON (exit={process.returncode}): "
                f"{stderr.decode('utf-8', errors='replace')[-4000:]}"
            ) from error
        if process.returncode != 0 or not envelope.get("ok"):
            detail = envelope.get("error") or stderr.decode("utf-8", errors="replace")[-4000:]
            raise RuntimeBridgeError(
                f"Runtime bridge operation {operation!r} failed: {detail}",
                envelope.get("details"),
            )
        return envelope["result"]
