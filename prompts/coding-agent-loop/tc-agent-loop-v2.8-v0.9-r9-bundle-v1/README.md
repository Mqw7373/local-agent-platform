# TC Agent Loop v2.8 / Adapter v0.9 / R9 Bundle v1

This append-only revision makes the role execution mapping part of Prompt authority.

The workflow topology is unchanged from v2.7. New runs use independent Codex executions for Document Preflight (`gpt-5.6-sol`), Developer (`gpt-6-astra`), Reviewer (`gpt-5.6-sol`), and Adjudicator (`gpt-6-astra`). Fresh Clean-room Challenger uses an external read-only DeepSeek adapter with `deepseek/deepseek-v4-flash` and never falls back to Codex.

Mastra and LangGraph share the same runtime adapters and Profile configuration. Existing v2.7 runs retain their frozen prompt authority and are not silently upgraded.
