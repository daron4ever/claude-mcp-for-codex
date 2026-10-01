import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { modelSchema, effortSchema, type Config } from "./config.js";

export const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(100_000)
    .refine((value) => value.trim().length > 0, "Prompt must not be blank")
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= 100_000,
      "Prompt must not exceed 100000 UTF-8 bytes",
    )
    .describe("Question and any explicitly supplied, sanitized context for Claude."),
  model: modelSchema.optional()
    .describe("Claude Code model alias or ID. Overrides the configured default when supplied."),
  effort: effortSchema.optional()
    .describe("Claude reasoning effort. Overrides the configured default when supplied."),
});

export type ClaudeInput = z.infer<typeof inputSchema>;

const reportedModelIdSchema = modelSchema
  .regex(/^claude-[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .refine((id) => id.trim() === id);

export const outputSchema = z.object({
  answer: z.string().min(1),
  metadata: z.object({
    requestedModel: modelSchema.nullable()
      .describe("Model passed to the CLI after argument/default precedence; null means CLI default."),
    requestedEffort: effortSchema.nullable()
      .describe("Effort passed to the CLI; this does not verify effective effort."),
    cliReportedModelIds: z.array(reportedModelIdSchema).max(16)
      .describe("CLI modelUsage keys, which may include auxiliary models; not independent attestation."),
    modelUsageStatus: z.enum(["reported", "unavailable", "invalid"]),
    effectiveModelVerified: z.literal(false),
    effectiveEffortVerified: z.literal(false),
  }),
});

export type ClaudeResult = z.infer<typeof outputSchema>;

const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string().min(1),
  modelUsage: z.unknown().optional(),
});

// Return only bounded model identifiers, never usage values or other CLI fields.
const modelUsageSchema = z.record(
  reportedModelIdSchema,
  z.object({}),
).refine((usage) => Object.keys(usage).length <= 16);

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const TERMINATION_GRACE_MS = 500;
const CLEANUP_DEADLINE_MS = 2_000;

// Only pass the host information needed for executable discovery, local login,
// and networking. API keys, provider overrides, and unrelated secrets are omitted.
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
    "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return env;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw new Error("Could not terminate the Claude Code process group.");
    }
  }
}

function invokeClaude(
  config: Config,
  input: ClaudeInput,
  signal: AbortSignal,
): Promise<ClaudeResult> {
  if (signal.aborted) return Promise.reject(new Error("Claude request cancelled."));
  const model = input.model ?? config.defaultModel;
  const effort = input.effort ?? config.defaultEffort;

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.binary,
      [
        "--print", "--output-format", "json",
        ...(model === undefined ? [] : ["--model", model]),
        ...(effort === undefined ? [] : ["--effort", effort]),
        "--safe-mode", "--tools", "", "--disallowedTools", "*",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--no-session-persistence",
        "--permission-mode", "default", "--setting-sources", "",
        "--settings", '{"disableAllHooks":true}',
      ],
      { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment() },
    );

    let failure: Error | undefined;
    let settled = false;
    let closed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    let graceTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;

    const finish = (result?: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearTimeout(graceTimer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (result !== undefined) resolve(result);
      else reject(new Error("Claude Code returned no answer."));
    };

    const kill = (signalName: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        signalGroup(child.pid, signalName);
      } catch {
        failure = new Error("Claude process cleanup could not be confirmed.");
      }
    };

    const stop = (message: string): void => {
      if (failure || settled) return;
      failure = new Error(message);
      stdout.length = 0;
      kill("SIGTERM");
      graceTimer = setTimeout(() => {
        kill("SIGKILL");
        if (closed) finish();
      }, TERMINATION_GRACE_MS);
      cleanupTimer = setTimeout(() => {
        kill("SIGKILL");
        if (!closed) {
          failure = new Error("Claude process cleanup could not be confirmed.");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        finish();
      }, CLEANUP_DEADLINE_MS);
    };

    const onAbort = (): void => stop("Claude request cancelled.");
    const requestTimer = setTimeout(
      () => stop("Claude request timed out."), config.timeoutMs,
    );

    child.once("error", () => {
      stop("Could not start Claude Code. Install it or set CLAUDE_BIN to its executable.");
    });
    child.stdin.on("error", () => stop("Could not send the prompt to Claude Code."));
    child.stdout.on("error", () => stop("Could not read the Claude Code response."));
    child.stderr.on("error", () => stop("Could not read Claude Code diagnostics."));

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop("Claude response exceeded the 1 MiB limit.");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) stop("Claude diagnostics exceeded the 64 KiB limit.");
    });

    child.once("close", (code, exitSignal) => {
      closed = true;
      if (failure) {
        // Keep the grace timer alive so a descendant that closed its pipes is
        // still terminated, even if the immediate CLI child already exited.
        if (child.pid === undefined) finish();
        return;
      }
      if (code !== 0 || exitSignal !== null) {
        stop("Claude Code failed. Check its installation, login, and supported flags locally.");
        return;
      }
      let result: ClaudeResult;
      try {
        const json: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
        );
        const parsed = resultSchema.parse(json);
        const usage = modelUsageSchema.safeParse(parsed.modelUsage);
        const modelIds = usage.success ? Object.keys(usage.data) : [];
        let modelUsageStatus: ClaudeResult["metadata"]["modelUsageStatus"] = "unavailable";
        if (parsed.modelUsage !== undefined && !usage.success) modelUsageStatus = "invalid";
        else if (modelIds.length > 0) modelUsageStatus = "reported";
        result = {
          answer: parsed.result,
          metadata: {
            requestedModel: model ?? null,
            requestedEffort: effort ?? null,
            cliReportedModelIds: modelIds,
            modelUsageStatus,
            effectiveModelVerified: false,
            effectiveEffortVerified: false,
          },
        };
      } catch {
        stop("Claude Code returned an invalid or unsuccessful JSON result.");
        return;
      }
      // Consultation mode should not leave background processes. Clear any
      // remaining members of the dedicated process group before returning.
      kill("SIGKILL");
      finish(result);
    });

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!failure) child.stdin.end(input.prompt, "utf8");
  });
}

export class ClaudeRunner {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<ClaudeResult>>();

  constructor(private readonly config: Config) {}

  async run(input: ClaudeInput, signal: AbortSignal): Promise<ClaudeResult> {
    const validated = inputSchema.parse(input);
    const request = invokeClaude(
      this.config, validated, AbortSignal.any([signal, this.shutdown.signal]),
    );
    this.pending.add(request);
    try {
      return await request;
    } finally {
      this.pending.delete(request);
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }
}
