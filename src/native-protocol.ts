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

export class NativeProtocolError extends Error {
  constructor(message: string, readonly category: "protocol" | "invalid_result" = "protocol") {
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
const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  model: reportedModelIdSchema,
  content: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("thinking"), thinking: z.string() }),
    z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
  ])).min(1),
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

  receive(value: unknown): void {
    const parsedFrame = recordSchema.safeParse(value);
    if (!parsedFrame.success || typeof parsedFrame.data.type !== "string") {
      throw new NativeProtocolError("Claude Code returned an invalid stream frame.", "invalid_result");
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
    } else if (frame.type === "result") {
      if (this.phase !== "inference" || this.result !== undefined) {
        throw new NativeProtocolError("Claude Code returned an out-of-order result.");
      }
      const result = resultSchema.safeParse(frame);
      if (!result.success) {
        throw new NativeProtocolError("Claude Code returned an invalid or unsuccessful JSON result.",
          "invalid_result");
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
