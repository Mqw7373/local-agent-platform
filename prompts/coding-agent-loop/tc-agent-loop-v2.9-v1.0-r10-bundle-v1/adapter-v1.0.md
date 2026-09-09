# TC Coding Platform Adapter v1.0

Status: APPROVED_FOR_PUBLICATION  
Core authority: `TC-SESSION-PROMPT-v2.9`

This adapter binds the Core Prompt to both shared orchestrators without changing product semantics.

## Role routing

| Role | Provider/backend | Exact model | Context | Product access | Invocation |
|---|---|---|---|---|---|
| Document Preflight | Codex CLI | `gpt-5.6-sol` | fresh ephemeral | read-only discarded mirror | once before Developer |
| Developer | Codex CLI | `gpt-6-astra` | role-isolated durable/resumable | validated write-through | initial task and code-remediation batches |
| Reviewer | Codex CLI | `gpt-5.6-sol` | fresh ephemeral | read-only discarded mirror | after each green candidate |
| Challenger | OpenRouter compatible | `deepseek/deepseek-v4-flash` | fresh ephemeral | bounded read-only tools | only when Reviewer returns `ESCALATE` |
| Adjudicator | Codex CLI | `gpt-6-astra` | fresh ephemeral | read-only discarded mirror | only after Challenger completes |

No provider or model fallback is permitted. Challenger credential/provider failure is relevant only after escalation and cannot block direct Reviewer closure.

## Reviewer Decision output

The structured output contains:

```text
disposition: NO_P0_P1 | DIRECT_CODE_REMEDIATION | DIRECT_DOCUMENT_REVIEW | DIRECT_EXTERNAL_STOP | ESCALATE
summary: non-empty string
findings: authoritative Reviewer findings for the exact candidate snapshot
escalationReasons: non-empty only for ESCALATE
```

The deterministic adapter rejects inconsistent combinations, including blocking findings under `NO_P0_P1`, non-code roots under `DIRECT_CODE_REMEDIATION`, non-document roots under `DIRECT_DOCUMENT_REVIEW`, code/document roots under `DIRECT_EXTERNAL_STOP`, and `ESCALATE` without a reason.

## Engine mapping

Mastra runs Reviewer followed by conditional Challenger and conditional Adjudicator steps. The latter steps pass through without model invocation when disposition is not `ESCALATE`.

LangGraph routes from Reviewer directly to Developer, Document Review, external stop, or Human Confirmation. Only `ESCALATE` creates graph edges to Challenger and Adjudicator.

Both engines retain the existing Frozen Bundle SHA gate, Developer-only writer lock, deterministic verification, event persistence, failed-workspace preservation, recovery assessment, applied-batch limit, append-only P2 ledger, and snapshot-bound Human Final Confirmation.
