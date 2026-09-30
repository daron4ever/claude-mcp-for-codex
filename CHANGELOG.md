# Changelog

## 0.1.0 - Unreleased

- Add a local stdio MCP server exposing `ask_claude` through the Claude Code CLI.
- Use existing CLI authentication and disable tool access and regular customization discovery for consultation calls.
- Add bounded process cleanup, safe errors, synthetic MCP tests, and a macOS/Linux CI workflow.
- Keep repeated and overlapping shutdown signals waiting for the same CLI cleanup operation.
- Include an MIT license and local Codex setup instructions.
- Add optional per-call Claude effort selection and document read-only review ownership and project/user configuration scopes.
- Resolve model and effort from tool arguments, then optional configured defaults; delegate unset fields to Claude Code.
- Document review-only `best`/`high` guidance overriding configured Opus 5.5/medium defaults.
