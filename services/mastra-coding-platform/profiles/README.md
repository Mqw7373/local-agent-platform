# Local project profiles

Project profiles in this directory are machine- and repository-specific and are ignored by Git.

Use `../coding-agent.config.json` as the public template. Register local profiles in `../coding-agent.profiles.json`. When that local registry is absent, the platform falls back to `../coding-agent.profiles.example.json` and exposes only the template profile.

Do not commit credentials, private repository names, absolute user paths, frozen product documents, or runtime output.
