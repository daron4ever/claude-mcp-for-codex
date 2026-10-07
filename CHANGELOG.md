# Changelog

## 0.1.0 - Unreleased

- Emit bounded content-free progress for supporting MCP clients and add observed response/retry timing to compact failure diagnostics; preserve deadlines, output capacity, privacy and CLI-applied settings verification. Codex UI display depends on client support.

- Allow an optional Claude request deadline up to 20 minutes, preserving the two-minute default and bounded cancellation/cleanup; document the corresponding MCP client timeout.
- Read native CLI-applied model/effort before and after each answer, correlate main-answer models and sessions, and scope verification flags explicitly to CLI-applied session evidence; provider attestation and reasoning allocation remain unverified. Preserve valid answers with false flags for unavailable, invalid or mismatched evidence.
- Require valid root-assistant attribution, role and answer-bearing content before verifying CLI-applied settings; malformed or thinking-only evidence cannot establish verification.
- Use bounded native stream-json control messages while preserving one prompt per process, tool restrictions, cancellation and cleanup; add safe protocol-phase failure diagnostics and controlled correlation/lifecycle regressions. The existing 1 MiB stdout cap now includes all verbose/control frames.

- Extend the opt-in context workflow with refreshed task snapshots, evidence and decision history, plus a synthetic request example; keep Claude stateless and read-only.
- Document optional Codex Code Mode result retention and bounded reads for long Claude responses, with session-lifetime and verification limitations.
- Document an opt-in Codex-led context-selection workflow with reusable AGENTS.md guidance and a synthetic prompt example; preserve tool-free Claude consultation and explicit context/verification limits.
- Add sanitized per-call failure timing, configured deadline, output byte counts and initial exit/close observations, with a separately labeled cleanup outcome; preserve short errors and never return partial assessments.
- Preserve answer text while adding requested model/effort, sanitized CLI-reported model IDs and explicit unverified effective-setting flags in text and structured MCP responses.
- Add a local stdio MCP server exposing `ask_claude` through the Claude Code CLI.
- Use existing CLI authentication and disable tool access and regular customization discovery for consultation calls.
- Add bounded process cleanup, safe errors, synthetic MCP tests, and a macOS/Linux CI workflow.
- Keep repeated and overlapping shutdown signals waiting for the same CLI cleanup operation.
- Include an MIT license and local Codex setup instructions.
- Add optional per-call Claude effort selection and document read-only review ownership and project/user configuration scopes.
- Resolve model and effort from tool arguments, then optional configured defaults; delegate unset fields to Claude Code.
- Document review-only `best`/`high` guidance overriding configured Opus 5.5/medium defaults.
