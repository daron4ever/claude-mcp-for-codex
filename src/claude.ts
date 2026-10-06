import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { modelSchema, effortSchema, type Config } from "./config.js";
import { NativeProtocol, NativeProtocolError, type ClaudeResult, type ProtocolPhase } from "./native-protocol.js";
export { outputSchema, type ClaudeResult } from "./native-protocol.js";

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

type FailureCategory = "timeout" | "cancelled" | "spawn" | "stdin" | "stdout" |
  "stderr" | "stdout_limit" | "stderr_limit" | "cli_exit" | "invalid_result" | "protocol" | "cleanup";

export type ClaudeFailureDiagnostics = {
  failureCategory: FailureCategory;
  phase: ProtocolPhase;
  elapsedMs: number;
  timeoutMs: number;
  firstStdoutMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  exitObserved: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  closeObserved: boolean;
  cleanupStatus: "close_observed" | "unconfirmed";
};

export class ClaudeExecutionError extends Error {
  constructor(message: string, readonly diagnostics: ClaudeFailureDiagnostics) {
    super(message);
    this.name = "ClaudeExecutionError";
  }
}

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
    const startedAt = performance.now();
    const child = spawn(
      config.binary,
      [
        "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
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
    let firstStdoutMs: number | null = null;
    let exitObserved = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let failureSnapshot: Omit<ClaudeFailureDiagnostics, "cleanupStatus"> | undefined;
    let cleanupUnconfirmed = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pendingLine = "";
    let graceTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const protocol = new NativeProtocol(input.prompt, model, effort, (frame) => {
      if (!failure && !settled) child.stdin.write(JSON.stringify(frame) + "\n", "utf8");
    }, () => {
      if (!failure && !settled) child.stdin.end();
    });

    // Freeze the initial boundary before cleanup changes process state.
    const recordFailure = (failureCategory: FailureCategory): void => {
      if (failureSnapshot !== undefined) return;
      failureSnapshot = {
        failureCategory,
        phase: protocol.phase,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timeoutMs: config.timeoutMs,
        firstStdoutMs,
        stdoutBytes,
        stderrBytes,
        exitObserved,
        exitCode,
        exitSignal,
        closeObserved: closed,
      };
    };

    const finish = (result?: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearTimeout(graceTimer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failureSnapshot === undefined ? failure : new ClaudeExecutionError(
          failure.message,
          { ...failureSnapshot,
            cleanupStatus: cleanupUnconfirmed || !closed ? "unconfirmed" : "close_observed" },
        ));
      } else if (result !== undefined) resolve(result);
      else reject(new Error("Claude Code returned no answer."));
    };

    const kill = (signalName: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        signalGroup(child.pid, signalName);
      } catch {
        recordFailure("cleanup");
        cleanupUnconfirmed = true;
        failure = new Error("Claude process cleanup could not be confirmed.");
      }
    };

    const stop = (message: string, category: FailureCategory): void => {
      if (failure || settled) return;
      recordFailure(category);
      failure = new Error(message);
      pendingLine = "";
      protocol.discard();
      kill("SIGTERM");
      graceTimer = setTimeout(() => {
        kill("SIGKILL");
        if (closed) finish();
      }, TERMINATION_GRACE_MS);
      cleanupTimer = setTimeout(() => {
        kill("SIGKILL");
        if (!closed) {
          cleanupUnconfirmed = true;
          failure = new Error("Claude process cleanup could not be confirmed.");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        finish();
      }, CLEANUP_DEADLINE_MS);
    };

    const onAbort = (): void => stop("Claude request cancelled.", "cancelled");
    const requestTimer = setTimeout(
      () => stop("Claude request timed out.", "timeout"), config.timeoutMs,
    );

    child.once("error", () => {
      stop("Could not start Claude Code. Install it or set CLAUDE_BIN to its executable.", "spawn");
    });
    child.stdin.on("error", () => stop("Could not send the prompt to Claude Code.", "stdin"));
    child.stdout.on("error", () => stop("Could not read the Claude Code response.", "stdout"));
    child.stderr.on("error", () => stop("Could not read Claude Code diagnostics.", "stderr"));

    child.once("exit", (code, signalName) => {
      exitObserved = true;
      exitCode = code;
      exitSignal = signalName;
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (firstStdoutMs === null) {
        firstStdoutMs = Math.max(0, Math.round(performance.now() - startedAt));
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop("Claude response exceeded the 1 MiB limit.", "stdout_limit");
        return;
      }
      try {
        pendingLine += decoder.decode(chunk, { stream: true });
        let newline: number;
        while (!failure && (newline = pendingLine.indexOf("\n")) >= 0) {
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          if (line.trim().length > 0) protocol.receive(JSON.parse(line));
        }
      } catch (error) {
        stop(error instanceof NativeProtocolError ? error.message :
          "Claude Code returned an invalid or unsuccessful JSON result.",
        error instanceof NativeProtocolError ? error.category : "invalid_result");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop("Claude diagnostics exceeded the 64 KiB limit.", "stderr_limit");
      }
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
        stop("Claude Code failed. Check its installation, login, and supported flags locally.",
          "cli_exit");
        return;
      }
      let result: ClaudeResult;
      try {
        // Validate final decoder/line state at normal close. EOF can precede
        // child reaping; it must not start cleanup against an exiting child.
        pendingLine += decoder.decode();
        if (pendingLine.trim().length > 0) {
          throw new NativeProtocolError("Claude Code returned an incomplete stream frame.", "invalid_result");
        }
        result = protocol.complete();
      } catch (error) {
        stop(error instanceof NativeProtocolError ? error.message :
          "Claude Code returned an invalid or unsuccessful JSON result.",
        error instanceof NativeProtocolError ? error.category : "invalid_result");
        return;
      }
      // Consultation mode should not leave background processes. Clear any
      // remaining members of the dedicated process group before returning.
      kill("SIGKILL");
      finish(result);
    });

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!failure) protocol.start();
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
