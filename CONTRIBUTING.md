# Contributing

Contributions are welcome through focused pull requests.

## Development setup

The reference environment is Windows 11, Node.js 22.13 or newer, Python 3.12
or newer, PowerShell, Git, and Codex CLI. See the root README for bootstrap and
test commands.

## Before opening a pull request

1. Do not commit a real project profile, credential, Frozen Bundle, retained
   execution workspace, or proprietary product document.
2. Preserve published Prompt bundles append-only. Publish a new version with
   predecessor hashes instead of editing an old bundle.
3. Keep Developer as the sole product-write role.
4. Add regression tests for routing, authority, recovery, or write-boundary
   changes.
5. Run `npm run check` from the repository root.

Pull requests should explain the observable behavior change, security or
authority impact, tests run, and backward-compatibility boundary.
