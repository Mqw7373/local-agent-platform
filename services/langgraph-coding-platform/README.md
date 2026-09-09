# LangGraph Coding Platform

This service is an alternative orchestrator for the shared Coding Agent Loop. It does not replace the Mastra implementation and does not contain a second Codex write adapter.

```text
Runtime & Frozen Bundle Preflight
→ Document Preflight → sealed DocumentPreflightReceipt
→ Developer
→ Automated Verification → Failure Classification
                         ├─code defect bound to diff──→ Developer
                         └─baseline/platform/profile/execution──→ stop outside Developer
→ Fresh Reviewer ──clear Code P0/P1──→ Developer
                 ├─clear Document P0/P1──→ document review/new Bundle
                 ├─No P0/P1──→ Human Final Confirmation
                 └─ESCALATE──→ Fresh Challenger → Adjudicator → root-cause route
```

The Python StateGraph calls `scripts/langgraph-runtime-bridge.ts` in the Mastra service. That bridge reuses the exact Prompt v2.9 binding, profile registry, deterministic preflight, structured preflight receipt sealing/validation, classified verification routing, role-routed model adapters, candidate hashing, verification commands, audit trace, and Developer-only validated write-through. A Developer no-op does not consume a code cycle, and a required-remediation no-op stops instead of looping. Document Preflight/Reviewer use `gpt-5.6-sol`, Developer and conditional Adjudicator use `gpt-6-astra`, and conditional Challenger uses `deepseek/deepseek-v4-flash` through the read-only OpenRouter adapter.

## Start

From the platform root:

```powershell
npm run bootstrap
npm run start:local
```

Or run only this service:

```powershell
Set-Location '<local-agent-platform>\services\langgraph-coding-platform'
.\.venv\Scripts\python.exe -m langgraph_coding_platform
```

Open `http://localhost:4130/ui` for the visual run console, or `http://localhost:4130/docs` for the local API.

## Start and inspect a run

```powershell
$body = @{
  projectProfile = 'cambioml-test'
  task = 'Implement the approved P0 scope in the Frozen Bundle.'
} | ConvertTo-Json

$run = Invoke-RestMethod -Method Post -Uri 'http://localhost:4130/runs' -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "http://localhost:4130$($run.statusUrl)"
```

Execution continues in the background. When the status becomes `AWAITING_HUMAN_CONFIRMATION`, copy the exact `runId`, `bundleSha256`, and `snapshotSha256` from the interrupt payload into the `/runs/{runId}/resume` request. Stale or mismatched approval bindings are rejected by the graph.

## Persistence and recovery

Checkpoints default to:

```text
%USERPROFILE%\.local-agent-platform\state\langgraph-coding\checkpoints.sqlite
```

Use `POST /runs/{runId}/continue` only for a non-failed paused graph. A failed Developer run cannot be continued blindly: inspect `GET /runs/{runId}/recovery`, record the side-effect review, and call `POST /runs/{runId}/recover`. The platform resumes the retained Codex session only when the Bundle SHA, original product baseline, retained workspace, terminated process state, side-effect review, and session id all match. Otherwise the assessment returns `RETRY`, `RESTART`, or `REJECT` and no product write occurs. LangGraph thread IDs are prefixed with `langgraph:` and stored in a separate SQLite database, so they cannot collide with Mastra state.

Developer evidence is retained under the Profile runtime directory in `developer-executions/<executionId>/`: `events.jsonl`, `progress.json`, `task-context.json`, `baseline-map.json`, `diff.patch`, `stderr.log`, `recovery-manifest.json`, and the isolated workspace. Events are streamed and redacted as they occur. Successful batches remain `APPLIED_PENDING_ACCEPTANCE`; failed batches remain `FAILED_RECOVERABLE`. Removal requires the explicit `/executions/{executionId}/cleanup` endpoint with a reason and confirmer.

The UI reports execution attempts separately from applied batches, plus current operation, last activity, elapsed time, remaining total-time budget, and recovery decision. A persisted failed execution overrides stale graph `next` nodes, so it cannot be displayed as running after a service restart.

## Engine boundary

- One run is owned by either Mastra or LangGraph, never both.
- Both engines may read the same registered profile.
- The shared per-profile Developer writer lock rejects concurrent product writes.
- Use isolated Git worktrees for deliberate A/B comparisons.
