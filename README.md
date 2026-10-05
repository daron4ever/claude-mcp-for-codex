# Claude MCP for Codex

A small, open-source MCP server that lets Codex ask **Claude Code** for a second opinion using your existing Claude Code login.

```text
Codex -> stdio MCP -> Claude Code CLI -> Claude
      <- answer    <- JSON result   <-
```

The server exposes one tool, `ask_claude`. Each call starts a fresh, text-only conversation. Supply the question and any sanitized code or context in the prompt. The initial version supports consultation; Claude's tools are disabled.

For code reviews, Claude returns findings and recommendations without editing files or running commands. Codex evaluates those findings and handles separately authorized code changes and validation. Claude receives only the supplied text; Codex must include the sanitized code or diff to be reviewed.

## Requirements

- Node.js 22 or newer.
- macOS or Linux; Windows users can run the server and Claude Code inside WSL.
- A separately installed, authenticated [Claude Code CLI](https://code.claude.com/docs/en/overview) supporting the flags listed below, including `--safe-mode`.
- Codex or another MCP client with stdio support.

Claude Code owns authentication. This project does not implement an API backend, request an API key, install Claude Code, or open a login flow. Run Claude Code yourself to finish its setup before connecting this server. Calls consume usage under your Claude account's applicable limits.

## Build from source

Clone the public repository and enter its directory:

```sh
git clone https://github.com/daron4ever/claude-mcp-for-codex.git
cd claude-mcp-for-codex
```

Run these commands from the cloned repository. OSV Scanner 2.x is needed for the dependency precheck; it is not a runtime dependency. Stop if a scan reports vulnerabilities and assess them before installing.

```sh
npm install --package-lock-only --ignore-scripts
node scripts/check-lockfile.mjs
npm audit
osv-scanner scan source .
```

After the prechecks pass:

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` typechecks, builds, and runs synthetic tests without invoking the real Claude CLI. The executable is `dist/index.js`. This package has not been published to npm; use the local build for now.

## Connect to Codex

Choose user scope (`~/.codex/config.toml`) for all your projects, or project scope (`<project>/.codex/config.toml`) for one trusted project. Project configuration takes precedence over user defaults. See [official OpenAI configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic).

Add the following table to your chosen Codex configuration, replacing the absolute path with your built checkout. This is a configuration example; the server does not modify Codex configuration itself.

```toml
[mcp_servers.claude]
command = "node"
args = ["/absolute/path/to/claude-mcp-for-codex/dist/index.js"]
tool_timeout_sec = 130

# Optional defaults; remove these two variables to use Claude runtime defaults.
[mcp_servers.claude.env]
CLAUDE_DEFAULT_MODEL = "claude-opus-5-5"
CLAUDE_DEFAULT_EFFORT = "medium"
```

Codex supports stdio commands, argument lists, forwarded environment variables, and tool timeouts. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

If `node` or `claude` is not on Codex's PATH, use an absolute path for `command`, and merge `CLAUDE_BIN` into the existing MCP environment table:

```toml
[mcp_servers.claude.env]
CLAUDE_BIN = "/absolute/path/to/claude"
```

Restart the Codex session after changing configuration. Confirm Codex recognizes the entry:

```sh
codex mcp list
```

Listing the entry confirms configuration discovery; it does not verify Claude authentication or a successful consultation. In the Codex CLI, use `/mcp` to inspect server status, then ask:

> Use ask_claude to explain the tradeoffs in this approach. Include only the sanitized example supplied here.

Or call the tool with:

```json
{
  "prompt": "Explain the tradeoffs of an in-memory queue for a single-process worker."
}
```

| Input | Behavior |
| --- | --- |
| `prompt` | Required nonblank text, at most 100,000 UTF-8 bytes. |
| `model` | Optional Claude Code alias or model ID; overrides `CLAUDE_DEFAULT_MODEL`. If neither is supplied, Claude Code selects its runtime default. |
| `effort` | Optional `low`, `medium`, `high`, `xhigh`, or `max`; overrides `CLAUDE_DEFAULT_EFFORT`. If neither is supplied, Claude Code selects the effort. |

## Select context before consulting Claude

Use Codex's existing code-navigation tools to gather relevant context before calling
`ask_claude`. This workflow uses the current `prompt` argument; the server does not
search files, maintain an index, or automatically load these instructions. To adopt
it, add the guidance below to your applicable `AGENTS.md`.

Include the current task's progress as well as relevant code. Each Claude call
starts fresh: a task number or a file path alone does not supply earlier work.
Codex prepares the task snapshot and includes it in the existing `prompt`; Claude
does not read the task registry or remember previous calls automatically.

```text
Before: Codex -> question + caller-assembled context -> Claude MCP

After:  current task record + authorized source
              -> Codex refreshes and sanitizes task snapshot + snippets
              -> bounded prompt -> fresh Claude MCP call -> assessment
              -> Codex checks evidence and handles approved changes
```

```markdown
## Context for Claude consultations
- Apply this workflow only when a Claude consultation is already authorized.
  Preserve the project's consultation and formal-review rules.
- State the decision, expected behavior and relevant constraints. Independently
  analyze the evidence before reading Claude's response.
- Before each authorized call, refresh the relevant task state from its current
  task record and authorized source. If there is no task record, use confirmed
  conversation facts and label unknowns; do not invent progress or decisions.
- Include the task identity, goal, approved scope, current step, completed work,
  remaining work and the specific question Claude should assess. Distinguish
  executed validation and its results from planned or unverified checks.
- Include settled requirements, approved decisions and their reasons. Label
  earlier Claude recommendations as advisory and state whether they were adopted,
  rejected or remain unresolved. Do not send raw conversation transcripts or
  Codex's tentative conclusions and preferred answer.
- Identify the source revision or working-tree state and changes since the last
  consultation. Supply the complete relevant current snapshot on every call;
  a task ID, previous-call reference or change-only update is insufficient.
- Use existing code-navigation tools within approved access. Read the named
  function and relevant callers, state owners or tests; do not send whole files
  when selected excerpts provide enough context.
- Send only minimized, sanitized source excerpts. Never include credentials,
  .env contents, customer data, production exports or raw production logs.
  Automated filtering alone does not establish that context is safe to share.
- Label excerpts with project-relative paths and original line numbers. State
  which revision or working-tree state they describe. Label redactions and gaps;
  snippets must not imply that omitted code was inspected or is absent.
- Keep the complete prompt within 100000 UTF-8 bytes, including the question,
  labels and constraints. Reduce irrelevant context explicitly; never silently
  truncate. If necessary evidence cannot fit or cannot safely be shared, report
  the limitation and request a narrower decision or additional authorization.
- Supply the applicable model and effort choices as tool arguments. Treat
  requested settings, CLI-reported models and verified settings separately;
  honor any rule requiring verified effective settings before relying on Claude.
- Ask Claude for findings, tradeoffs and uncertainty using only supplied context.
  Codex checks the claims against source and handles separately approved edits.
  Missing context requires further evidence, not automatic retries or acceptance.
- When the answer arrives, check it against the latest task and source state.
  Reconcile stale assumptions before using the advice; do not automatically
  repeat the call. Record concise adopted recommendations and reconciliation
  reasons in the existing task record, without copying the transcript.
```

For example, this valid tool request supplies a synthetic task snapshot and code
excerpt. The task, progress and decisions below are illustrative, not results
from this repository. Use the model and effort required by your own instructions.

```json
{
  "prompt": "Task snapshot: synthetic example, task #3.\nGoal: cancellation stops this worker. Approved scope: cancellation behavior only; no unrelated changes.\nCurrent step: assess behavior when cancellation arrives during job execution.\nCompleted work: added the pre-start cancellation check shown below. Validation: no checks have been executed in this example.\nRemaining work: establish the job's cancellation contract, implement any approved correction, and validate the affected flow.\nSettled decision: Codex owns edits; Claude provides advice only. Prior Claude advice: none.\nChanges since the previous consultation: first consultation. Source state: synthetic excerpt, no repository revision.\nEvidence: worker.js lines 1-4:\n1 export async function run(job, signal) {\n2   if (signal.aborted) throw new Error('cancelled');\n3   return await job();\n4 }\nCoverage: job implementation and callers are not supplied; do not assume their behavior.\nQuestion: what evidence is needed to assess cancellation during job execution? Return findings, options and uncertainty using only supplied context. Do not edit files or run tools.",
  "model": "opus",
  "effort": "high"
}
```

The wrapper validates the prompt's size and shape, but cannot establish that it is
sanitized, sufficient, current or correctly attributed. Codex owns those checks.
Adopting this guidance supplies task continuity through updated prompts; it adds
no server-side memory, automatic file loading or session resumption. Smaller,
relevant context may help large consultations; this workflow has not been shown to
resolve intermittent timeouts and does not verify applied model or effort. A
separate semantic index is optional infrastructure, not required for this flow.

## Keep long Claude responses available

Codex can truncate oversized tool output before its model reads it. Increasing
the [tool-output budget](https://learn.chatgpt.com/docs/config-file/config-reference)
gives headroom, but does not retain an omitted answer.

When your Codex client exposes Code Mode with
[`store` and `load`](https://github.com/openai/codex/blob/44dd77b71e88c78295736bffd3dc3b684c13be6d/codex-rs/code-mode-protocol/src/description.rs#L23-L44),
use this caller workflow for an authorized consultation:

1. Discover and validate the live Claude tool definition. Send only approved,
   minimized, sanitized context and the applicable model/effort arguments.
2. Call Claude through Code Mode and store the complete returned result under
   a distinct key before printing anything. Print only that key, success/error
   status, answer size, and the execution metadata.
3. Load the retained result in later cells and print bounded answer sections.
   Account for UTF-8 size, JSON escaping and the active output budget; a fixed
   character count is not a guaranteed token bound. If a section is truncated,
   read a smaller section from the same retained result.
4. Track coverage and read all relevant sections before presenting Claude's
   conclusions. Label any incomplete assessment. Retrieving a section does
   not require another Claude call.
5. Keep requested settings, CLI-reported usage and effective-setting evidence
   separate. This workflow does not verify applied effort or waive your
   consultation, review or access requirements.

```text
Before: Claude -> direct tool output -> client budget -> omitted sections

After:  Claude -> Code Mode store -> bounded reads -> Codex assessment
```

The retained result belongs to the current Code Mode session. Do not assume it
survives a restart, compaction, or client recovery unless the client documents
and verifies that behavior. This workflow does not retrospectively recover a
previous direct call. Do not write responses to disk without approval.

If Code Mode, `store` or `load` is unavailable, request a concise assessment and
use the documented tool-output budget when supported by your installed Codex
version. Report incomplete output; do not silently repeat a paid consultation.

To adopt this workflow, copy the following guidance into your applicable
`AGENTS.md`. The server does not automatically retain results or load it.

```markdown
## Retain Claude consultation results
- For an authorized Claude consultation, when Code Mode store/load is available,
  retain the complete result under a distinct session key before printing it.
- Print bounded status/metadata, then load and read answer sections within the
  active output budget. Read all relevant sections before assessing findings.
- Retrieve missing sections from the retained result rather than calling Claude
  again. If retention or output coverage is unavailable, disclose the limitation.
- Preserve existing access, sanitation, model/effort verification, consultation,
  formal-review and implementation-approval requirements. Do not persist answers
  to files without approval.
```

## Execution metadata and failures

Successful calls keep Claude's answer unchanged in the first MCP text block. A second text block contains execution metadata, and `structuredContent` contains both `answer` and `metadata` under the tool's advertised output schema. For example, an `opus`/`high` request might return:

```json
{
  "answer": "Claude's answer...",
  "metadata": {
    "requestedModel": "opus",
    "requestedEffort": "high",
    "cliReportedModelIds": ["claude-opus-5"],
    "modelUsageStatus": "reported",
    "effectiveModelVerified": false,
    "effectiveEffortVerified": false
  }
}
```

`requestedModel` and `requestedEffort` are the values passed to the CLI after tool arguments override configured defaults. `null` means that field was omitted and Claude chooses its default. `cliReportedModelIds` contains only validated identifiers from the CLI's `modelUsage` object; it can include auxiliary models and is not independent proof of the model that produced the answer. The example above is illustrative, not a guarantee of what `opus` resolves to.

`modelUsageStatus` is `reported` when valid IDs are present, `unavailable` when usage is absent or empty, and `invalid` when usage has an unsupported shape or identifiers. Invalid metadata is omitted without discarding a valid answer. Extraction accepts at most 16 model IDs, each matching the supported `claude-...` identifier syntax and the existing 128-character model limit. Usage values, session IDs and unrelated CLI fields are never included in metadata. Both effective-setting verification flags remain `false`; requested settings or CLI-reported usage do not establish independent verification. A strict `AGENTS.md` rule requiring verified effective settings may still require a decision to proceed.

Failures set `isError: true` and keep the short error message in the first text block. Failures after CLI launch add a second text block labeled `Claude failure diagnostics (initial state before cleanup):`, followed by JSON such as:

```json
{
  "failureCategory": "timeout",
  "elapsedMs": 300004,
  "timeoutMs": 300000,
  "firstStdoutMs": null,
  "stdoutBytes": 0,
  "stderrBytes": 0,
  "exitObserved": false,
  "exitCode": null,
  "exitSignal": null,
  "closeObserved": false,
  "cleanupStatus": "close_observed"
}
```

This is an illustrative timeout, not a runtime measurement. `elapsedMs` uses a monotonic clock from launch to the initial failure, excluding cleanup; `timeoutMs` is the configured deadline in that running server. `firstStdoutMs` is the first received stdout time from launch, or `null` when none arrived. Byte counts describe output received before failure, not its content or validity. `exitObserved`, `exitCode`, `exitSignal` and `closeObserved` describe the initial failure boundary **before** wrapper termination; null exit fields alone do not establish that the CLI was still running. An observed exit with no close can indicate still-open stdio pipes. Output bytes do not establish a completed assessment or identify a network/model issue.

`failureCategory` records the first wrapper boundary: `timeout`, `cancelled`, `spawn`, `stdin`, `stdout`, `stderr`, `stdout_limit`, `stderr_limit`, `cli_exit`, `invalid_result` or `cleanup`. `cleanupStatus` separately describes the final cleanup observation: `close_observed` means the immediate child closed and no process-group signaling failure was observed; `unconfirmed` means cleanup could not be confirmed. It does not attest to descendants outside the process group. A cleanup failure can replace the first error message while retaining the original category and snapshot.

Failure diagnostics contain no prompts, paths, settings, raw CLI output, partial answers or model/effort verification claims. Error responses do not include successful execution metadata or `structuredContent`. Input validation and cancellation before launch can return only the short message. A client/transport timeout that prevents the server response from arriving cannot carry these diagnostics.

Codex can follow a review policy in your project `AGENTS.md` or user `~/.codex/AGENTS.md`. For example:

```markdown
## Code reviews
- When a review is requested, call the Claude MCP tool `ask_claude`.
- Use model `best` with effort `high` for reviews only.
- Supply only sanitized code and context. Ask for findings and recommendations only.
- Codex evaluates the findings and handles fixes under the project's approval rules.
```

This instruction directs Codex to pass the model and effort as tool arguments. The server does not read `AGENTS.md` itself. Claude Code's `best` alias selects the model that `fable` resolves to when Fable is available to your account, otherwise the same model as `opus`. Alias versions depend on the CLI/provider; use `claude-fable-5-1` when you need that exact version rather than an evolving alias. See [Claude model configuration](https://code.claude.com/docs/en/model-config) and [official OpenAI AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Resolve each field independently in this order:

1. Codex passes the applicable `AGENTS.md` choice as a tool argument.
2. For an omitted argument, the server uses its configured default from `config.toml`.
3. If both sources omit the field, the server leaves its CLI flag out and Claude Code selects its runtime default under the restricted launch described below.

For example, add these optional defaults to your chosen Codex configuration. Merge them into an existing `[mcp_servers.claude.env]` table if you already have one:

```toml
[mcp_servers.claude.env]
CLAUDE_DEFAULT_MODEL = "claude-opus-5-5"
CLAUDE_DEFAULT_EFFORT = "medium"
```

Normal consultation calls with no model/effort arguments use Opus 5.5 and medium effort. The review policy above makes Codex pass `best` and `high`, overriding both configured defaults. Supplying only one argument overrides only that field. Directly supplied tool arguments also override the server defaults; the wrapper cannot distinguish arguments chosen from instructions from manually supplied arguments. Invalid supplied arguments fail validation, and invalid configured defaults prevent startup rather than silently falling back.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Executable name or path, without extra arguments. |
| `CLAUDE_TIMEOUT_MS` | `120000` | Request timeout; integer from 1,000 to 600,000 milliseconds. |
| `CLAUDE_DEFAULT_MODEL` | Unset | Optional model alias or ID used when the tool omits `model`. |
| `CLAUDE_DEFAULT_EFFORT` | Unset | Optional `low`, `medium`, `high`, `xhigh`, or `max` used when the tool omits `effort`. |

Set Codex's `tool_timeout_sec` longer than this timeout plus the two-second cleanup allowance. No `.env` file is loaded. For an existing login stored in a nonstandard Claude configuration directory, forward your existing `CLAUDE_CONFIG_DIR` through Codex's `env_vars`; the wrapper does not inspect that directory.

## Process and data boundaries

The wrapper spawns the executable directly with `shell: false` and passes the prompt through stdin. Prompts are absent from the command-line arguments. It invokes Claude Code with:

```text
--print --output-format json
--safe-mode
--tools "" --disallowedTools "*"
--strict-mcp-config --mcp-config '{"mcpServers":{}}'
--disable-slash-commands --no-session-persistence
--permission-mode default --setting-sources ""
--settings '{"disableAllHooks":true}'
```

The wrapper adds `--model <model>` and `--effort <effort>` only when their fields are supplied by tool arguments or configured defaults. It does not enforce a built-in model or effort fallback. Regular Claude user/project/local settings are disabled by the restricted launch; delegating to Claude defaults does not re-enable those settings. Invalid tool argument values are rejected before launch. Claude Code determines the effective model and effort, and may lower effort to a level supported by the model or allowed by organization policy; the wrapper does not verify those effective selections. See [Claude effort levels](https://code.claude.com/docs/en/model-config#adjust-effort-level). CLI failures are returned without an automatic retry or fallback by this wrapper.

`--safe-mode` skips regular customizations while preserving authentication. `--bare` is intentionally not used: it skips subscription credentials. Built-in and MCP tools are denied. See the [CLI reference](https://code.claude.com/docs/en/cli-reference) and [programmatic use](https://code.claude.com/docs/en/headless).

Only a fixed set of environment variables for executable discovery, local authentication location, locale, proxies, and CA certificates is forwarded. API keys, provider selectors, injected Node options, and unrelated environment secrets are omitted. `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` is set. The wrapper stores no prompts or answers and never logs raw stderr or unsuccessful stdout.

Claude Code remains responsible for its own authentication, network traffic, and local operational state. These flags are not an OS sandbox. Managed organization policy still applies, and managed hooks cannot be disabled by these user-level flags. See [Claude Code hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks). Account administrators remain responsible for managed policy. Only explicitly supplied, sanitized text should be sent: never `.env` contents, secrets, credentials, production exports, or customer data.

Each request has independent state. Cancellation, timeout, and shutdown send SIGTERM to its POSIX process group, then SIGKILL after 500 ms. Cleanup waits at most two seconds and reports failure if the immediate child's close cannot be confirmed. Descendants that deliberately escape the process group are outside this cleanup boundary. Stdout is limited to 1 MiB and stderr to 64 KiB. No automatic retries or session resumption occur.

## Troubleshooting

- **Could not start Claude Code:** install the CLI separately or set `CLAUDE_BIN` to its executable. Shell aliases and `.cmd` wrappers are not supported.
- **Claude Code failed:** check installation, authentication, model availability, and flag support directly in your terminal. Unsupported flags fail the call; the server never retries with weaker restrictions.
- **Timed out:** inspect the failure diagnostics' actual `timeoutMs`, elapsed time and initial exit/close observations. These identify the wrapper boundary, not its root cause. If changing `CLAUDE_TIMEOUT_MS`, also leave the MCP client's timeout longer than the deadline plus cleanup, then restart the MCP connection to load the change. A client timeout or stale running server requires separate evidence.
- **Invalid or unsuccessful JSON result:** update to a compatible Claude Code CLI and check its behavior locally. Raw error payloads are deliberately not relayed.

Local synthetic tests establish the wrapper's protocol and process behavior. They do not establish login health, model availability, or compatibility with a particular installed Claude Code version. Validate those separately before relying on the integration.

## Development and release

The runtime uses the official MCP TypeScript SDK and Zod. Tests use Node's built-in test runner and an executable fixture created under the ignored `.cache/` directory. CI repeats the checks on macOS and Linux with Node.js 22 and 24.

For dependency changes, resolve the lockfile with scripts disabled, run npm audit and OSV Scanner, inspect changed package sources and install-script metadata, then install only after the checks pass. Keep changes focused and use synthetic test data.

Build and inspect the release package locally:

```sh
npm run build
npm pack --ignore-scripts
```

The GitHub repository is maintained under [daron4ever/claude-mcp-for-codex](https://github.com/daron4ever/claude-mcp-for-codex). npm publication is a separate maintainer action; this package has not been published to npm. This is an independent community project, not an official Anthropic or OpenAI product. It is licensed under MIT; Claude Code remains separately distributed by Anthropic.
