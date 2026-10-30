import { randomUUID } from "node:crypto";
import { z } from "zod";
import { modelSchema, effortSchema } from "./config.js";

const reportedModelIdSchema = modelSchema
  .regex(/^claude-[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .refine((id) => id.trim() === id);
const appliedSchema = z.object({ model: reportedModelIdSchema, effort: effortSchema });
type Applied = z.infer<typeof appliedSchema>;
type Readback = { status: "available"; settings: Applied } |
  { status: "unavailable" | "invalid"; settings: null };

export const outputSchema = z.object({
  answer: z.string().min(1),
  metadata: z.object({
    requestedModel: modelSchema.nullable()
      .describe("Model passed to the CLI; null delegates to the CLI default."),
    requestedEffort: effortSchema.nullable()
      .describe("Effort passed to the CLI; null delegates to the CLI default."),
    cliReportedModelIds: z.array(reportedModelIdSchema).max(16)
      .describe("Aggregate modelUsage keys, which may include auxiliary models."),
    modelUsageStatus: z.enum(["reported", "unavailable", "invalid"]),
    effectiveModelVerified: z.boolean()
      .describe("Verified only within settingsEvidence.scope, not provider-attested."),
    effectiveEffortVerified: z.boolean()
      .describe("Verified CLI-applied session effort, not provider reasoning allocation."),
    settingsEvidence: z.object({
      scope: z.literal("cli_applied_session"),
      status: z.enum(["verified", "unavailable", "invalid", "mismatch"]),
      before: appliedSchema.nullable(),
      after: appliedSchema.nullable(),
      answerModelIds: z.array(reportedModelIdSchema).max(16),
      sessionCorrelated: z.boolean(),
      requestedModelMatch: z.enum([
        "exact", "different", "alias_unchecked", "cli_default", "unavailable",
      ]),
      requestedEffortMatched: z.boolean().nullable(),
      providerAttested: z.literal(false),
      reasoningAllocationVerified: z.literal(false),
    }),
  }),
});
export type ClaudeResult = z.infer<typeof outputSchema>;
export type ProtocolPhase = "initialize" | "settings_before" | "inference" |
  "settings_after" | "closing";
export type ProtocolActivity = "response" | "retry";

const cliResultSubtypeSchema = z.enum([
  "success", "error_during_execution", "error_max_turns", "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
export type CliResultSubtype = z.infer<typeof cliResultSubtypeSchema>;
// Published SDK categories only; never classify by searching error text.
const cliAssistantErrorSchema = z.enum([
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required",
  "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found",
  "server_error", "unknown", "max_output_tokens", "cloud_credential_error",
]);
type CliAssistantError = z.infer<typeof cliAssistantErrorSchema>;
type AssistantErrorState = "reported" | "not_observed" | "unrecognized" | "invalid" |
  "uncorrelated" | "conflicting" | "superseded";
export type CliErrorEvidence = {
  cliApiErrorStatus: number | null;
  cliApiErrorStatusState: "reported" | "explicit_null" | "missing" | "invalid" | "not_applicable";
  cliPrecedingAssistantError: CliAssistantError | null;
  cliPrecedingAssistantErrorState: AssistantErrorState | "not_applicable";
};
export type InvalidResultReason = "invalid_utf8" | "invalid_json" | "invalid_frame" |
  "invalid_result_shape" | "cli_error_result" | "incomplete_frame" | "unexpected_exception";
export type ResultFailureDetails = {
  failureReason: InvalidResultReason;
  cliResultSubtype: CliResultSubtype | null;
} & Partial<CliErrorEvidence>;

export class NativeProtocolError extends Error {
  constructor(
    message: string,
    readonly category: "protocol" | "invalid_result" = "protocol",
    readonly details?: ResultFailureDetails,
  ) {
    super(message);
    this.name = "NativeProtocolError";
  }
}

const recordSchema = z.record(z.string(), z.unknown());
const controlSchema = z.object({
  request_id: z.string(), subtype: z.enum(["success", "error"]),
  response: z.unknown().optional(),
});
const resultSchema = z.object({
  type: z.literal("result"), subtype: z.literal("success"),
  is_error: z.literal(false), result: z.string().min(1),
  modelUsage: z.unknown().optional(),
});
const modelUsageSchema = z.record(reportedModelIdSchema, z.object({}))
  .refine((usage) => Object.keys(usage).length <= 16);
const sessionSchema = z.string().min(1).max(256);
const apiErrorStatusSchema = z.number().int().min(100).max(599);
const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  model: reportedModelIdSchema,
  content: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("thinking"), thinking: z.string() }),
    z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
  ])).min(1),
});
const retrySchema = z.object({
  attempt: z.number().int().min(1),
  max_retries: z.number().int().min(0),
  retry_delay_ms: z.number().int().min(0),
  error_status: z.number().int().min(100).max(599).nullable(),
  session_id: sessionSchema,
});

// Project only applied fields; full settings and error payloads are never retained.
function readback(payload: unknown): Readback {
  const root = recordSchema.safeParse(payload);
  if (payload === undefined) return { status: "unavailable", settings: null };
  if (!root.success) return { status: "invalid", settings: null };
  const value = root.data.applied;
  if (value === undefined) return { status: "unavailable", settings: null };
  const applied = recordSchema.safeParse(value);
  if (!applied.success) return { status: "invalid", settings: null };
  if (applied.data.model === undefined || applied.data.effort === undefined) {
    return { status: "unavailable", settings: null };
  }
  const parsed = appliedSchema.safeParse(value);
  return parsed.success ? { status: "available", settings: parsed.data } :
    { status: "invalid", settings: null };
}

// This object belongs to exactly one invocation. Process lifetime stays in ClaudeRunner.
export class NativeProtocol {
  phase: ProtocolPhase = "initialize";
  private readonly ids = { initialize: randomUUID(), before: randomUUID(), after: randomUUID() };
  private before: Readback = { status: "unavailable", settings: null };
  private after: Readback = { status: "unavailable", settings: null };
  private systemSession: string | undefined;
  private assistantSessions = new Set<string>();
  private resultSession: string | undefined;
  private answerModels = new Set<string>();
  private assistantObserved = false;
  private answerTextObserved = false;
  private initObserved = false;
  private evidenceInvalid = false;
  private evidenceMissing = false;
  // Independent of answer verification; no raw messages or extra session IDs retained.
  private precedingAssistantError: CliAssistantError | null = null;
  private precedingAssistantErrorState: AssistantErrorState = "not_observed";
  private result: {
    answer: string;
    modelIds: string[];
    modelUsageStatus: ClaudeResult["metadata"]["modelUsageStatus"];
  } | undefined;

  constructor(
    private readonly prompt: string,
    private readonly model: string | undefined,
    private readonly effort: z.infer<typeof effortSchema> | undefined,
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly endInput: () => void,
  ) {}

  start(): void {
    this.control(this.ids.initialize, { subtype: "initialize", hooks: {}, sdkMcpServers: [] });
  }

  private control(id: string, request: Record<string, unknown>): void {
    this.send({ type: "control_request", request_id: id, request });
  }

  private session(value: unknown): string | undefined {
    const parsed = sessionSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (value === undefined || value === null || value === "") this.evidenceMissing = true;
    else this.evidenceInvalid = true;
    return undefined;
  }

  private hasPendingAssistantError(): boolean {
    return this.precedingAssistantErrorState !== "not_observed" &&
      this.precedingAssistantErrorState !== "superseded";
  }

  private clearAssistantError(state: AssistantErrorState): void {
    this.precedingAssistantError = null;
    this.precedingAssistantErrorState = state;
  }

  private observeAssistantError(frame: Record<string, unknown>): void {
    const hasError = frame.error !== undefined;
    const pending = this.hasPendingAssistantError();
    if (!hasError && !pending) return;
    if (frame.parent_tool_use_id !== null) {
      // Explicit auxiliary frames do not change main-session evidence.
      if (!sessionSchema.safeParse(frame.parent_tool_use_id).success && (hasError || pending)) {
        this.clearAssistantError("uncorrelated");
      }
      return;
    }
    const session = sessionSchema.safeParse(frame.session_id);
    if (!session.success || this.systemSession === undefined || session.data !== this.systemSession) {
      if (hasError || pending) this.clearAssistantError("uncorrelated");
      return;
    }
    if (!hasError) {
      if (assistantMessageSchema.safeParse(frame.message).success) {
        if (this.precedingAssistantErrorState !== "not_observed") {
          this.clearAssistantError("superseded");
        }
      } else if (pending) this.clearAssistantError("invalid");
      return;
    }
    // Synthetic API-error messages need not carry an ordinary answer-model ID.
    const message = recordSchema.safeParse(frame.message);
    if (!message.success || message.data.role !== "assistant") {
      this.clearAssistantError("invalid");
      return;
    }
    const category = cliAssistantErrorSchema.safeParse(frame.error);
    if (!category.success) {
      this.clearAssistantError(typeof frame.error === "string" ? "unrecognized" : "invalid");
      return;
    }
    if (this.precedingAssistantErrorState === "reported") {
      if (this.precedingAssistantError !== category.data) this.clearAssistantError("conflicting");
    } else if (!pending) {
      this.precedingAssistantError = category.data;
      this.precedingAssistantErrorState = "reported";
    }
    // Ambiguous evidence stays unavailable until a correlated response/retry supersedes it.
  }

  private errorEvidence(frame: Record<string, unknown>, subtype: CliResultSubtype): CliErrorEvidence {
    let cliApiErrorStatus: number | null = null;
    let cliApiErrorStatusState: CliErrorEvidence["cliApiErrorStatusState"] = "not_applicable";
    if (subtype === "success") {
      const status = apiErrorStatusSchema.safeParse(frame.api_error_status);
      if (!Object.hasOwn(frame, "api_error_status")) cliApiErrorStatusState = "missing";
      else if (frame.api_error_status === null) cliApiErrorStatusState = "explicit_null";
      else if (status.success) {
        cliApiErrorStatus = status.data;
        cliApiErrorStatusState = "reported";
      } else cliApiErrorStatusState = "invalid";
    }
    const session = sessionSchema.safeParse(frame.session_id);
    const correlated = session.success && this.systemSession !== undefined &&
      session.data === this.systemSession;
    const cliPrecedingAssistantErrorState = this.precedingAssistantErrorState === "reported" &&
      !correlated ? "uncorrelated" : this.precedingAssistantErrorState;
    return {
      cliApiErrorStatus, cliApiErrorStatusState,
      cliPrecedingAssistantError: cliPrecedingAssistantErrorState === "reported" ?
        this.precedingAssistantError : null,
      cliPrecedingAssistantErrorState,
    };
  }

  receive(value: unknown): ProtocolActivity | undefined {
    const parsedFrame = recordSchema.safeParse(value);
    if (!parsedFrame.success || typeof parsedFrame.data.type !== "string") {
      throw new NativeProtocolError("Claude Code returned an invalid stream frame.", "invalid_result",
        { failureReason: "invalid_frame", cliResultSubtype: null });
    }
    const frame = parsedFrame.data;
    if (frame.type === "control_request") {
      throw new NativeProtocolError("Claude Code requested an unsupported operation.");
    }
    if (frame.type === "control_response") {
      const response = controlSchema.safeParse(frame.response);
      const id = this.phase === "initialize" ? this.ids.initialize :
        this.phase === "settings_before" ? this.ids.before :
          this.phase === "settings_after" ? this.ids.after : undefined;
      if (!response.success || id === undefined || response.data.request_id !== id) {
        throw new NativeProtocolError("Claude Code returned an unexpected control response.");
      }
      if (this.phase === "initialize") {
        if (response.data.subtype !== "success") {
          throw new NativeProtocolError("Claude Code could not initialize the native protocol.");
        }
        this.phase = "settings_before";
        this.control(this.ids.before, { subtype: "get_settings" });
      } else if (this.phase === "settings_before") {
        this.before = response.data.subtype === "success" ? readback(response.data.response) :
          { status: "unavailable", settings: null };
        this.phase = "inference";
        this.send({ type: "user", message: { role: "user", content: this.prompt },
          parent_tool_use_id: null });
      } else {
        this.after = response.data.subtype === "success" ? readback(response.data.response) :
          { status: "unavailable", settings: null };
        this.phase = "closing";
        this.endInput();
      }
      return;
    }
    if (frame.type === "system" && frame.subtype === "init") {
      if (this.phase !== "inference" || this.initObserved) {
        throw new NativeProtocolError("Claude Code returned an unexpected session initialization.");
      }
      this.initObserved = true;
      this.systemSession = this.session(frame.session_id);
    } else if (frame.type === "assistant") {
      if (this.phase !== "inference") {
        throw new NativeProtocolError("Claude Code returned an out-of-order assistant message.");
      }
      const message = recordSchema.safeParse(frame.message);
      if (message.success && Array.isArray(message.data.content) &&
        message.data.content.some((block: unknown) => {
          const parsed = recordSchema.safeParse(block);
          return parsed.success && ["tool_use", "server_tool_use"].includes(String(parsed.data.type));
        })) {
        throw new NativeProtocolError("Claude Code attempted an unsupported tool operation.");
      }
      this.observeAssistantError(frame);
      // Auxiliary messages never establish main-answer evidence.
      if (frame.parent_tool_use_id !== null) {
        if (frame.parent_tool_use_id === undefined) this.evidenceMissing = true;
        else if (!sessionSchema.safeParse(frame.parent_tool_use_id).success) this.evidenceInvalid = true;
        return;
      }
      if (frame.error !== undefined) {
        this.evidenceInvalid = true;
        return;
      }
      if (frame.message === undefined || message.success &&
        [message.data.role, message.data.model, message.data.content].includes(undefined)) {
        this.evidenceMissing = true;
        return;
      }
      const assistant = assistantMessageSchema.safeParse(frame.message);
      if (!assistant.success) {
        this.evidenceInvalid = true;
        return;
      }
      this.assistantObserved = true;
      this.answerTextObserved ||= assistant.data.content.some(block =>
        block.type === "text" && block.text.trim().length > 0);
      const session = this.session(frame.session_id);
      if (session !== undefined) this.assistantSessions.add(session);
      const model = assistant.data.model;
      if (this.answerModels.has(model) || this.answerModels.size < 16) this.answerModels.add(model);
      else this.evidenceInvalid = true;
      if (session !== undefined) return "response";
    } else if (frame.type === "result") {
      if (this.phase !== "inference" || this.result !== undefined) {
        throw new NativeProtocolError("Claude Code returned an out-of-order result.");
      }
      // The CLI also uses subtype=success with is_error=true for API errors.
      // Recognize only the declaration; raw bodies and unknown subtypes never
      // enter diagnostics. A declared failure is never an assessment.
      const declaredError = cliResultSubtypeSchema.safeParse(frame.subtype);
      if (frame.is_error === true && declaredError.success) {
        const evidence = this.errorEvidence(frame, declaredError.data);
        const summary = [
          ...(evidence.cliApiErrorStatus === null ? [] :
            [`cliApiErrorStatus=${evidence.cliApiErrorStatus}`]),
          ...(evidence.cliPrecedingAssistantError === null ? [] :
            [`cliPrecedingAssistantError=${evidence.cliPrecedingAssistantError}`]),
        ];
        throw new NativeProtocolError(
          `Claude Code reported an unsuccessful result (${declaredError.data}).` +
            (summary.length === 0 ? "" : " " + summary.join(" ")),
          "invalid_result",
          { failureReason: "cli_error_result", cliResultSubtype: declaredError.data, ...evidence },
        );
      }
      const result = resultSchema.safeParse(frame);
      if (!result.success) {
        throw new NativeProtocolError("Claude Code returned an invalid result envelope.",
          "invalid_result", { failureReason: "invalid_result_shape", cliResultSubtype: null });
      }
      const usage = modelUsageSchema.safeParse(result.data.modelUsage);
      const modelIds = usage.success ? Object.keys(usage.data) : [];
      this.result = {
        answer: result.data.result, modelIds,
        modelUsageStatus: modelIds.length > 0 ? "reported" :
          result.data.modelUsage !== undefined && !usage.success ? "invalid" : "unavailable",
      };
      this.resultSession = this.session(frame.session_id);
      this.phase = "settings_after";
      this.control(this.ids.after, { subtype: "get_settings" });
      if (this.resultSession !== undefined) return "response";
    } else if (frame.type === "system" && frame.subtype === "api_retry" &&
      this.phase === "inference") {
      const retry = retrySchema.safeParse(frame);
      if (retry.success) {
        if (this.hasPendingAssistantError()) {
          this.clearAssistantError(this.systemSession !== undefined &&
            retry.data.session_id === this.systemSession ? "superseded" : "uncorrelated");
        }
        return "retry";
      }
      if (this.hasPendingAssistantError()) this.clearAssistantError("invalid");
    }
    // Other notifications are ignored, but still consume the cumulative output budget.
  }

  discard(): void { this.result = undefined; }

  complete(): ClaudeResult {
    if (this.phase !== "closing" || this.result === undefined) {
      throw new NativeProtocolError("Claude Code closed before completing the native protocol.");
    }
    const before = this.before.settings;
    const after = this.after.settings;
    const sessionCorrelated = this.systemSession !== undefined && this.resultSession !== undefined &&
      this.assistantObserved && this.assistantSessions.size === 1 &&
      this.assistantSessions.has(this.systemSession) && this.resultSession === this.systemSession &&
      !this.evidenceMissing && !this.evidenceInvalid;
    const requestedModelMatch: ClaudeResult["metadata"]["settingsEvidence"]["requestedModelMatch"] =
      this.model === undefined ? "cli_default" : !this.model.startsWith("claude-") ?
        "alias_unchecked" : before === null ? "unavailable" :
          this.model === before.model ? "exact" : "different";
    const requestedEffortMatched = this.effort === undefined || before === null ? null :
      this.effort === before.effort;
    let status: ClaudeResult["metadata"]["settingsEvidence"]["status"] = "verified";
    if (this.before.status === "invalid" || this.after.status === "invalid" || this.evidenceInvalid) {
      status = "invalid";
    } else if (before === null || after === null || !this.assistantObserved || !this.answerTextObserved ||
      !this.initObserved ||
      this.evidenceMissing || this.answerModels.size === 0) {
      status = "unavailable";
    } else if (!sessionCorrelated || before.model !== after.model || before.effort !== after.effort ||
      this.answerModels.size !== 1 || !this.answerModels.has(before.model) ||
      requestedModelMatch === "different" || requestedEffortMatched === false) {
      status = "mismatch";
    }
    return {
      answer: this.result.answer,
      metadata: {
        requestedModel: this.model ?? null, requestedEffort: this.effort ?? null,
        cliReportedModelIds: this.result.modelIds, modelUsageStatus: this.result.modelUsageStatus,
        effectiveModelVerified: status === "verified", effectiveEffortVerified: status === "verified",
        settingsEvidence: {
          scope: "cli_applied_session", status, before, after,
          answerModelIds: [...this.answerModels], sessionCorrelated, requestedModelMatch,
          requestedEffortMatched, providerAttested: false, reasoningAllocationVerified: false,
        },
      },
    };
  }
}
