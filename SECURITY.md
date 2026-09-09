# Security policy

## Supported versions

Security fixes are applied to the latest tagged release and the default branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, credential exposure, or unsafe
product-write bypass. Use GitHub's private vulnerability reporting feature on
this repository. Include the affected revision, operating system, reproduction
steps, impact, and whether any product repository or credential was exposed.

Please do not include real API keys, Codex authentication files, private
repository content, or retained execution workspaces in a report. Replace
sensitive values with redacted evidence.

## Trust boundary

The Developer role can modify files within a configured product scope. Review
all project profiles and Frozen Bundles before running it. Reviewer,
Challenger, Adjudicator, the Hub, and integrations are not product-write
authorities. A workflow result is not release approval; only the configured
human confirmation can issue GO.
