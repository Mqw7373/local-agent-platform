# Multica–Mastra Bridge

A reusable local bridge that lets Multica act as the ticket, monitoring, comment, status, and human-control surface for Mastra workflows. One Bridge process can connect multiple Multica workspaces, Mastra servers, projects, and workflow adapters.

The Bridge does not bind tickets directly to arbitrary repository paths. A ticket selects a configured **binding**, and that binding selects a registered Mastra `projectProfile`. This keeps repository access under the Coding Platform's allow-listed project configuration.

## Authority boundary

- Mastra remains the workflow engine and source of workflow outcomes.
- Only the Developer role inside the Mastra Coding Agent Loop may modify product code.
- Multica, the Bridge, Reviewer, Challenger, and Adjudicator are read-only with respect to product code.
- The Bridge mirrors evidence and relays explicit control requests; it does not review, adjudicate, or grant GO.
- A Multica issue status is never interpreted as human approval.
- Human GO or NO-GO must be explicitly sent to the Bridge while the Mastra run is suspended at `human-final-confirmation`.

## Data flow

```text
Multica issue
  -> configured Bridge binding
  -> registered Mastra workflow + project profile
  -> Mastra run
  -> Bridge polling and milestone interpretation
  -> Multica metadata, comments, and status
  -> explicit human GO/NO-GO
  -> suspended Mastra run resumes
```

## Requirements

- Node.js 22.13 or newer
- A running Multica backend
- A running Mastra server exposing the configured workflow
- A Multica workspace ID, project ID, and personal access token for live ticket integration

No npm dependencies are required by this Bridge.

## Configuration

The default configuration is [`bridge.config.json`](./bridge.config.json). Override its location with `MULTICA_MASTRA_BRIDGE_CONFIG`.

Configuration is split into four independent layers:

- `multicaConnections`: Multica server, workspace, and credential definitions.
- `mastraConnections`: Mastra server definitions.
- `bindings`: a Multica project to Mastra workflow/project-profile mapping.
- `adapter`: workflow-specific input construction and output interpretation.

The included `cambioml-computer-use` binding maps to:

```text
Multica connection: local
Mastra connection: coding-platform (http://localhost:4113)
Workflow: codingAgentLoopWorkflow
Registered project profile: cambioml-test
Actual profile repository: <local product repository>
```

The repository path is configured in the Coding Platform profile, not accepted from a Multica ticket.

### Environment variables

Set these values in the shell that starts the Bridge:

```powershell
$env:MULTICA_WORKSPACE_ID = '<workspace-id>'
$env:MULTICA_TOKEN = '<personal-access-token>'
$env:MULTICA_PROJECT_CAMBIOML_ID = '<project-id>'
```

Optional variables:

```powershell
# Protects all mutating Bridge endpoints with Authorization: Bearer <token>.
$env:MULTICA_MASTRA_BRIDGE_TOKEN = '<bridge-control-token>'

# Loads a different configuration file.
$env:MULTICA_MASTRA_BRIDGE_CONFIG = 'C:\absolute\path\bridge.config.json'
```

Do not commit access tokens into `bridge.config.json`. Creating or rotating a Multica personal access token is an explicit human administration action.

## Run locally

```powershell
Set-Location '<local-agent-platform>\services\multica-mastra-bridge'
npm test
npm start
```

The default service address is `http://127.0.0.1:4120`.

Health and binding readiness:

```powershell
Invoke-RestMethod 'http://127.0.0.1:4120/healthz'
Invoke-RestMethod 'http://127.0.0.1:4120/v1/bindings'
```

A binding with missing Multica credentials or project ID is shown as inactive. The service still starts so its configuration and health can be inspected safely.

Runtime state is persisted atomically below `%USERPROFILE%\.local-agent-platform\state`. Override that shared data root with `LOCAL_AGENT_PLATFORM_HOME`. The caller-owned Mastra run ID is recorded before dispatch, allowing later polling to reconcile an acknowledged async start whose first run snapshot is not immediately visible.

## Start from a Multica ticket

Create a normal issue in the Multica project selected by the binding. The issue description, falling back to its title, becomes the coding task.

Add both primitive metadata values to make the issue discoverable:

```text
mastra_bridge.binding = cambioml-computer-use
mastra_bridge.action = start
```

Using the Multica REST API:

```powershell
$headers = @{
  Authorization = "Bearer $env:MULTICA_TOKEN"
  'X-Workspace-ID' = $env:MULTICA_WORKSPACE_ID
}
$issueId = '<issue-id>'
$base = 'http://localhost:8080'

Invoke-RestMethod -Method Put -Headers $headers `
  -Uri "$base/api/issues/$issueId/metadata/mastra_bridge.binding" `
  -ContentType 'application/json' `
  -Body '{"value":"cambioml-computer-use"}'

Invoke-RestMethod -Method Put -Headers $headers `
  -Uri "$base/api/issues/$issueId/metadata/mastra_bridge.action" `
  -ContentType 'application/json' `
  -Body '{"value":"start"}'
```

The poller claims each binding/issue pair only once. It writes the Mastra run ID and workflow state back as `mastra_bridge.*` metadata, posts milestone comments, and synchronizes the issue status with `suppress_run: true` so Multica does not launch a separate native agent.

## Start through the Bridge API

Use this when the issue already exists and you want immediate dispatch rather than waiting for discovery:

```powershell
$bridgeHeaders = @{ 'Content-Type' = 'application/json' }
# If MULTICA_MASTRA_BRIDGE_TOKEN is set:
# $bridgeHeaders.Authorization = 'Bearer <bridge-control-token>'

$body = @{
  bindingId = 'cambioml-computer-use'
  issueId = '<issue-id>'
  task = 'Optional task override; otherwise use issue description/title.'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Headers $bridgeHeaders `
  -Uri 'http://127.0.0.1:4120/v1/runs' -Body $body
```

Read-only monitoring endpoints:

```text
GET /v1/bindings
GET /v1/runs
GET /v1/runs/{bridge-run-id}
```

Mutating control endpoints:

```text
POST /v1/poll
POST /v1/runs
POST /v1/runs/{bridge-run-id}/sync
POST /v1/runs/{bridge-run-id}/decision
POST /v1/runs/{bridge-run-id}/cancel
```

## Human final decision

Submit a decision only when the run reports:

```text
state = AWAITING_HUMAN_FINAL_CONFIRMATION
requiresHuman = true
```

Then explicitly relay GO or NO-GO:

```powershell
$decision = @{
  decision = 'GO' # or NO_GO
  confirmedBy = 'human-name'
  note = 'Reviewed the final evidence.'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Headers $bridgeHeaders `
  -Uri 'http://127.0.0.1:4120/v1/runs/<bridge-run-id>/decision' `
  -Body $decision
```

The Bridge rejects decisions outside the human-confirmation gate and requires a non-empty `confirmedBy`. It resumes Mastra step `human-final-confirmation`; a later sync records Mastra's authoritative final result.

## Add another project

1. Register the repository as an allow-listed project profile in the target Mastra Coding Platform.
2. Add a new environment variable for the corresponding Multica project ID.
3. Add a binding in `bridge.config.json` with a unique ID, Multica connection, project ID, Mastra connection, workflow ID, adapter, and `projectProfile`.
4. Restart the Bridge and confirm `ready: true` at `/v1/bindings`.
5. Trigger tickets with the new binding ID.

Example:

```json
{
  "theme-research": {
    "enabled": true,
    "multicaConnection": "local",
    "multicaProjectId": "${MULTICA_PROJECT_THEME_ID}",
    "mastraConnection": "theme-server",
    "workflowId": "themeResearchWorkflow",
    "adapter": "coding-agent-loop",
    "adapterConfig": {
      "projectProfile": "theme-research"
    }
  }
}
```

Only use `coding-agent-loop` for workflows with the same input and output contract. A workflow with different steps or result fields needs its own adapter before activation.

## Add another Multica workspace or Mastra server

Add another entry under `multicaConnections` or `mastraConnections`, then reference its ID from one or more bindings. This lets one Bridge process serve all configured projects without merging their repositories, Mastra runtimes, credentials, or workflow authority.

Use separate tokens and control access where workspace isolation requires it. If teams should not share a process-level security boundary, run separate Bridge instances with separate config and state files.

## Monitoring granularity

The current Coding Agent Loop is exposed by Mastra as a large `implementation-cycle` step followed by `human-final-confirmation`. The Bridge can therefore mirror run state, high-level phase, cycle count, findings summary, bundle/snapshot hashes, and final-decision readiness. It cannot observe every internal Developer, Reviewer, Challenger, or Adjudicator transition unless the workflow later emits those transitions through richer Mastra step output or events.

## Security and operational notes

- Keep the Bridge bound to `127.0.0.1` unless network exposure is intentional and protected.
- Set `MULTICA_MASTRA_BRIDGE_TOKEN` before exposing the service to any untrusted local or network client.
- Read endpoints do not currently require the control token; do not expose them if issue/run metadata is sensitive.
- Multica metadata supports primitive values only, at most 50 keys and 8 KB total, with keys matching `^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`.
- The Bridge never writes product repository files and never accepts a repository path from an issue.
- Do not trigger a coding workflow until its required PRD, ADR, System Design, API Contract, Acceptance Criteria, and approved Frozen Bundle are ready under the workflow's own contract.
