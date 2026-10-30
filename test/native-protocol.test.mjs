import assert from "node:assert/strict";
import test from "node:test";
import { NativeProtocol, NativeProtocolError, outputSchema } from "../dist/native-protocol.js";

const settings = { model: "claude-opus-5-5", effort: "high" };
const sessionId = "synthetic-sensitive-session";
function conversation({ model = "opus", effort = "high" } = {}) {
  const sent = [];
  let eof = 0;
  const protocol = new NativeProtocol("literal synthetic prompt", model, effort,
    frame => sent.push(frame), () => { eof++; });
  const reply = (payload, subtype = "success") => protocol.receive({
    type: "control_response", response: {
      request_id: sent.at(-1).request_id, subtype, response: payload,
      error: "synthetic-sensitive-error",
    },
  });
  protocol.start();
  return { protocol, sent, reply, eof: () => eof };
}
function answer(c, options = {}) {
  if (!options.omitInit) c.protocol.receive({
    type: "system", subtype: "init", session_id: options.initSession ?? sessionId,
  });
  if (!options.omitAssistant) c.protocol.receive({
    type: "assistant", ...(options.omitParent ? {} : { parent_tool_use_id: options.parent ?? null }),
    session_id: options.assistantSession ?? sessionId,
    message: Object.hasOwn(options, "message") ? options.message : {
      role: "assistant", model: options.answerModel ?? settings.model,
      content: [{ type: "text", text: "answer" }], secret: "synthetic-sensitive-message" },
  });
  c.protocol.receive({ type: "result", subtype: "success", is_error: false,
    result: "answer", session_id: options.resultSession ?? sessionId,
    effectiveModelVerified: true, effectiveEffortVerified: true,
    modelUsage: { "claude-haiku-4-5": { secret: "synthetic-sensitive-usage" } },
  });
}
function run({ before = { applied: settings }, after = { applied: settings },
  beforeSubtype = "success", afterSubtype = "success", ...options } = {}) {
  const c = conversation();
  c.reply({}); c.reply(before, beforeSubtype); answer(c, options); c.reply(after, afterSubtype);
  const result = c.protocol.complete();
  assert.equal(c.eof(), 1);
  assert.equal(c.sent.filter(frame => frame.type === "user").length, 1);
  assert.equal(new Set(c.sent.filter(frame => frame.type === "control_request")
    .map(frame => frame.request_id)).size, 3);
  assert.equal(outputSchema.safeParse(result).success, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|session_id|secret/);
  return result;
}

test("CLI readbacks and main answer establish bounded session evidence, independently of aggregate usage", () => {
  const result = run({ before: { applied: { ...settings, secret: "synthetic-sensitive" },
    env: { token: "synthetic-sensitive" } }, after: { applied: settings } });
  assert.equal(result.answer, "answer");
  assert.equal(result.metadata.effectiveModelVerified, true);
  assert.equal(result.metadata.effectiveEffortVerified, true);
  assert.equal(result.metadata.settingsEvidence.status, "verified");
  assert.equal(result.metadata.settingsEvidence.scope, "cli_applied_session");
  assert.equal(result.metadata.settingsEvidence.providerAttested, false);
  assert.equal(result.metadata.settingsEvidence.reasoningAllocationVerified, false);
  assert.deepEqual(result.metadata.cliReportedModelIds, ["claude-haiku-4-5"]);
});

function assistantError(error = "rate_limit", fields = {}) {
  return { type: "assistant", parent_tool_use_id: null, session_id: sessionId, error,
    message: { role: "assistant", model: "<synthetic>",
      content: [{ type: "text", text: "synthetic-sensitive-error-body" }] }, ...fields };
}
function declaredFailure(frames = [], fields = {}, { init = true } = {}) {
  const c = conversation(); c.reply({}); c.reply({ applied: settings });
  if (init) c.protocol.receive({ type: "system", subtype: "init", session_id: sessionId });
  for (const frame of frames) c.protocol.receive(frame);
  let failure;
  assert.throws(() => c.protocol.receive({ type: "result", subtype: "success", is_error: true,
    result: "synthetic-sensitive-result-body", session_id: sessionId, ...fields }), error => {
    failure = error;
    assert.equal(error.category, "invalid_result");
    assert.equal(error.details.failureReason, "cli_error_result");
    assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-sensitive|<synthetic>/);
    return true;
  });
  assert.throws(() => c.protocol.complete(), /before completing/);
  assert.equal(c.sent.filter(frame => frame.type === "control_request").length, 2);
  assert.equal(c.eof(), 0);
  return failure;
}

test("declared errors expose correlated category and terminal status without raw error bodies", () => {
  const failure = declaredFailure([assistantError()], { api_error_status: 429 });
  assert.equal(failure.details.cliApiErrorStatus, 429);
  assert.equal(failure.details.cliApiErrorStatusState, "reported");
  assert.equal(failure.details.cliPrecedingAssistantError, "rate_limit");
  assert.equal(failure.details.cliPrecedingAssistantErrorState, "reported");
});

test("only published assistant categories are reported, including literal unknown", () => {
  for (const category of ["authentication_failed", "oauth_org_not_allowed", "account_on_hold",
    "verification_required", "billing_error", "rate_limit", "overloaded", "invalid_request",
    "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"]) {
    const failure = declaredFailure([assistantError(category)]);
    assert.equal(failure.details.cliPrecedingAssistantError, category);
    assert.equal(failure.details.cliPrecedingAssistantErrorState, "reported");
    assert.match(failure.message, new RegExp(`cliPrecedingAssistantError=${category}`));
  }
});

test("terminal API status distinguishes absent, null and invalid values without coercion", () => {
  const cases = [[{}, null, "missing"], [{ api_error_status: null }, null, "explicit_null"],
    ...[100, 200, 401, 429, 599].map(value => [{ api_error_status: value }, value, "reported"]),
    ...[undefined, "401", "synthetic-sensitive-status", 99, 600, -1, 401.5, NaN, Infinity,
      true, [], { secret: "synthetic-sensitive" }].map(value =>
      [{ api_error_status: value }, null, "invalid"])];
  for (const [fields, value, state] of cases) {
    const failure = declaredFailure([], fields);
    assert.equal(failure.details.cliApiErrorStatus, value);
    assert.equal(failure.details.cliApiErrorStatusState, state);
    assert.equal(failure.details.cliPrecedingAssistantErrorState, "not_observed");
  }
  const failure = declaredFailure([assistantError()], {
    subtype: "error_max_turns", api_error_status: 429,
  });
  assert.equal(failure.details.cliApiErrorStatus, null);
  assert.equal(failure.details.cliApiErrorStatusState, "not_applicable");
  assert.equal(failure.details.cliPrecedingAssistantError, "rate_limit");
});

const ordinaryAssistant = { type: "assistant", parent_tool_use_id: null, session_id: sessionId,
  message: { role: "assistant", model: settings.model, content: [{ type: "text", text: "answer" }] } };
const retryFrame = { type: "system", subtype: "api_retry", session_id: sessionId,
  attempt: 1, max_retries: 2, retry_delay_ms: 0, error_status: 529,
  error: "synthetic-sensitive-retry-error" };

test("assistant error evidence rejects uncertain identity, malformed and conflicting segments", () => {
  const cases = [
    [[assistantError("rate_limit", { parent_tool_use_id: "synthetic-sensitive-auxiliary" })],
      {}, {}, "not_observed"],
    ...[undefined, 7, ""].map(parent_tool_use_id => [
      [assistantError("rate_limit", { parent_tool_use_id })], {}, {}, "uncorrelated"]),
    ...[undefined, null, "", 7, "synthetic-sensitive-other"].map(session_id => [
      [assistantError("rate_limit", { session_id })], {}, {}, "uncorrelated"]),
    ...[undefined, null, 7, { role: "user" }].map(message => [
      [assistantError("rate_limit", { message })], {}, {}, "invalid"]),
    [[assistantError()], {}, { init: false }, "uncorrelated"],
    [[assistantError()], { session_id: "synthetic-sensitive-other" }, {}, "uncorrelated"],
    [[assistantError()], { session_id: undefined }, {}, "uncorrelated"],
    [[assistantError("synthetic-sensitive-unknown")], {}, {}, "unrecognized"],
    ...[null, 7, [], { secret: "synthetic-sensitive" }].map(value => [
      [assistantError(value)], {}, {}, "invalid"]),
    [[assistantError(), assistantError("server_error"), assistantError()], {}, {}, "conflicting"],
    [[assistantError(), assistantError("synthetic-sensitive-unknown")], {}, {}, "unrecognized"],
    [[assistantError("synthetic-sensitive-unknown"), assistantError()], {}, {}, "unrecognized"],
    [[assistantError(), assistantError(null)], {}, {}, "invalid"],
    [[assistantError(), { ...ordinaryAssistant, parent_tool_use_id: undefined }], {}, {}, "uncorrelated"],
    [[assistantError(), { ...ordinaryAssistant, message: null }], {}, {}, "invalid"],
    [[assistantError(), { ...retryFrame, error_status: "synthetic-sensitive" }], {}, {}, "invalid"],
    [[assistantError(), { ...retryFrame, session_id: "synthetic-sensitive-other" }], {}, {}, "uncorrelated"],
    [[assistantError(), { type: "system", subtype: "init", session_id: sessionId }],
      {}, { init: false }, "uncorrelated"],
  ];
  for (const [frames, fields, options, state] of cases) {
    const failure = declaredFailure(frames, fields, options);
    assert.equal(failure.details.cliPrecedingAssistantError, null);
    assert.equal(failure.details.cliPrecedingAssistantErrorState, state);
  }
});

test("only correlated recovery supersedes errors; later fresh errors can be reported", () => {
  for (const recovery of [ordinaryAssistant, retryFrame]) {
    const failure = declaredFailure([assistantError(), recovery]);
    assert.equal(failure.details.cliPrecedingAssistantError, null);
    assert.equal(failure.details.cliPrecedingAssistantErrorState, "superseded");
    const fresh = declaredFailure([assistantError(), recovery, assistantError("server_error")]);
    assert.equal(fresh.details.cliPrecedingAssistantError, "server_error");
    assert.equal(fresh.details.cliPrecedingAssistantErrorState, "reported");
    const conflictRecovered = declaredFailure([
      assistantError(), assistantError("server_error"), recovery, assistantError("billing_error"),
    ]);
    assert.equal(conflictRecovered.details.cliPrecedingAssistantError, "billing_error");
  }
  const same = declaredFailure([assistantError(), assistantError(), assistantError("server_error", {
    parent_tool_use_id: "synthetic-sensitive-auxiliary",
  })]);
  assert.equal(same.details.cliPrecedingAssistantError, "rate_limit");
  assert.equal(declaredFailure().details.cliPrecedingAssistantErrorState, "not_observed");
});

test("error observations do not become success metadata or relax existing verification", () => {
  const c = conversation(); c.reply({}); c.reply({ applied: settings });
  c.protocol.receive({ type: "system", subtype: "init", session_id: sessionId });
  c.protocol.receive(assistantError());
  c.protocol.receive(retryFrame);
  answer(c, { omitInit: true }); c.reply({ applied: settings });
  const result = c.protocol.complete();
  assert.equal(result.answer, "answer");
  assert.equal(result.metadata.settingsEvidence.status, "invalid");
  assert.equal(result.metadata.effectiveModelVerified, false);
  assert.equal(result.metadata.effectiveEffortVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /cliApiError|cliPreceding|rate_limit|synthetic-sensitive/);
});

test("recognized unsuccessful result declarations expose only allowlisted classification", () => {
  for (const subtype of ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd",
    "error_max_structured_output_retries"]) {
    const c = conversation(); c.reply({}); c.reply({ applied: settings });
    assert.throws(() => c.protocol.receive({ type: "result", subtype, is_error: true,
      errors: ["synthetic-sensitive-cause"], session_id: sessionId,
      result: "synthetic-sensitive-assessment", settings: { secret: "synthetic-sensitive" } }), error => {
      assert.equal(error.category, "invalid_result");
      assert.deepEqual(error.details, { failureReason: "cli_error_result", cliResultSubtype: subtype,
        cliApiErrorStatus: null, cliApiErrorStatusState: subtype === "success" ? "missing" : "not_applicable",
        cliPrecedingAssistantError: null, cliPrecedingAssistantErrorState: "not_observed" });
      assert.match(error.message, new RegExp(subtype));
      assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic-sensitive/);
      return true;
    });
    assert.throws(() => c.protocol.complete(), /before completing/);
    assert.equal(c.eof(), 0);
    assert.equal(c.sent.filter(frame => frame.type === "control_request").length, 2);
  }
});

test("unknown or contradictory result declarations stay invalid without echoing payloads", () => {
  for (const fields of [
    { subtype: "synthetic-sensitive-unknown", is_error: true, result: "synthetic-sensitive" },
    { subtype: "error_during_execution", is_error: false },
    { subtype: "error_during_execution", is_error: "synthetic-sensitive" },
    { subtype: "error_during_execution" },
    { subtype: "success", is_error: "true", result: "synthetic-sensitive" },
    { subtype: "success", result: "synthetic-sensitive" },
    { subtype: "success", is_error: false, result: "" },
    { subtype: "success", is_error: false },
    { subtype: "success", is_error: false, result: 7 },
    { subtype: null, is_error: true },
  ]) {
    const c = conversation(); c.reply({}); c.reply({ applied: settings });
    assert.throws(() => c.protocol.receive({ type: "result", ...fields }), error => {
      assert.equal(error.category, "invalid_result");
      assert.deepEqual(error.details, { failureReason: "invalid_result_shape", cliResultSubtype: null });
      assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic-sensitive/);
      return true;
    });
  }
});

test("invalid root frames and out-of-order failed results retain distinct boundaries", () => {
  for (const value of [null, [], 7, "synthetic-sensitive", {}, {type:3}]) {
    assert.throws(() => conversation().protocol.receive(value), error => {
      assert.deepEqual(error.details, { failureReason: "invalid_frame", cliResultSubtype: null });
      assert.doesNotMatch(error.message, /synthetic-sensitive/);
      return true;
    });
  }
  for (const subtype of ["success", "error_during_execution"]) {
    const failed = { type: "result", subtype, is_error: true };
    for (const ready of [false, true]) {
      const c = conversation();
      if (ready) { c.reply({}); c.reply({ applied: settings }); answer(c); }
      assert.throws(() => c.protocol.receive(failed), error => {
        assert.equal(error.category, "protocol");
        assert.equal(error.details, undefined);
        return true;
      });
    }
  }
});

test("activity excludes controls, initialization, auxiliary and malformed response evidence", () => {
  const c = conversation();
  assert.equal(c.reply({}), undefined);
  assert.equal(c.reply({ applied: settings }), undefined);
  assert.equal(c.protocol.receive({ type: "system", subtype: "init", session_id: sessionId }), undefined);
  const main = { type: "assistant", parent_tool_use_id: null, session_id: sessionId,
    message: { role: "assistant", model: settings.model,
      content: [{ type: "thinking", thinking: "synthetic-sensitive-thinking" }] } };
  assert.equal(c.protocol.receive({ ...main, parent_tool_use_id: "synthetic-sidechain" }), undefined);
  assert.equal(c.protocol.receive({ ...main, message: { ...main.message, role: "user" } }), undefined);
  assert.equal(c.protocol.receive({ ...main, session_id: undefined }), undefined);
  assert.equal(c.protocol.receive(main), "response");
  assert.equal(c.protocol.receive({ type: "stream_event", event: {
    type: "content_block_delta", delta: { text: "synthetic-sensitive" } } }), undefined);
  assert.equal(c.protocol.receive({ type: "result", subtype: "success", is_error: false,
    result: "exact answer", session_id: sessionId }), "response");
  assert.equal(c.reply({ applied: settings }), undefined);
  assert.equal(c.protocol.complete().answer, "exact answer");
});

test("only well-formed retry notifications during inference count, without changing evidence", () => {
  const c = conversation();
  const retry = { type: "system", subtype: "api_retry", attempt: 3, max_retries: 1,
    retry_delay_ms: 100, error_status: null, session_id: sessionId,
    error: "synthetic-sensitive-error", no_response: { secret: "synthetic-sensitive" } };
  assert.equal(c.protocol.receive(retry), undefined);
  c.reply({}); c.reply({ applied: settings });
  for (const field of ["attempt", "max_retries", "retry_delay_ms", "error_status", "session_id"]) {
    for (const value of [undefined, -1, 1.5, field === "session_id" ? "" : "synthetic-sensitive"]) {
      assert.equal(c.protocol.receive({ ...retry, [field]: value }), undefined);
    }
  }
  assert.equal(c.protocol.receive(retry), "retry");
  assert.equal(c.protocol.receive({ ...retry, error_status: 529 }), "retry");
  answer(c);
  assert.equal(c.protocol.receive(retry), undefined);
  c.reply({ applied: settings });
  assert.equal(c.protocol.receive(retry), undefined);
  assert.equal(c.protocol.complete().metadata.settingsEvidence.status, "verified");
});

for (const [name, options, status] of [
  ["before unavailable", { before: {} }, "unavailable"],
  ["after unavailable", { after: {} }, "unavailable"],
  ["before error", { beforeSubtype: "error" }, "unavailable"],
  ["after error", { afterSubtype: "error" }, "unavailable"],
  ["missing effort", { before: { applied: { model: settings.model } } }, "unavailable"],
  ["missing model", { after: { applied: { effort: "high" } } }, "unavailable"],
  ["invalid model", { before: { applied: { model: "synthetic-sensitive", effort: "high" } } }, "invalid"],
  ["invalid effort", { after: { applied: { model: settings.model, effort: "synthetic-sensitive" } } }, "invalid"],
  ["invalid applied shape", { before: { applied: [] } }, "invalid"],
  ["model changed", { after: { applied: { model: "claude-sonnet-4-5", effort: "high" } } }, "mismatch"],
  ["effort changed", { after: { applied: { model: settings.model, effort: "medium" } } }, "mismatch"],
  ["assistant model mismatch", { answerModel: "claude-sonnet-4-5" }, "mismatch"],
  ["init session mismatch", { initSession: "synthetic-other-session" }, "mismatch"],
  ["assistant session mismatch", { assistantSession: "synthetic-other-session" }, "mismatch"],
  ["result session mismatch", { resultSession: "synthetic-other-session" }, "mismatch"],
  ["missing init", { omitInit: true }, "unavailable"],
  ["missing assistant", { omitAssistant: true }, "unavailable"],
  ["auxiliary-only assistant", { parent: "synthetic-sidechain" }, "unavailable"],
  ["missing parent attribution", { omitParent: true }, "unavailable"],
  ["invalid parent attribution", { parent: 7 }, "invalid"],
  ["missing assistant message", { message: undefined }, "unavailable"],
  ["missing role", { message: { model: settings.model,
    content: [{ type: "text", text: "answer" }] } }, "unavailable"],
  ["contradictory role", { message: { role: "user", model: settings.model,
    content: [{ type: "text", text: "answer" }] } }, "invalid"],
  ["missing content", { message: { role: "assistant", model: settings.model } }, "unavailable"],
  ["scalar content", { message: { role: "assistant", model: settings.model, content: 7 } }, "invalid"],
  ["empty content", { message: { role: "assistant", model: settings.model, content: [] } }, "invalid"],
  ["invalid text block", { message: { role: "assistant", model: settings.model,
    content: [{ type: "text", text: 7 }] } }, "invalid"],
  ["empty answer text", { message: { role: "assistant", model: settings.model,
    content: [{ type: "text", text: "" }] } }, "unavailable"],
  ["thinking without answer text", { message: { role: "assistant", model: settings.model,
    content: [{ type: "thinking", thinking: "synthetic" }] } }, "unavailable"],
]) {
  test(`${name} never verifies settings or discards a structurally valid answer`, () => {
    const result = run(options);
    assert.equal(result.answer, "answer");
    assert.equal(result.metadata.settingsEvidence.status, status);
    assert.equal(result.metadata.effectiveModelVerified, false);
    assert.equal(result.metadata.effectiveEffortVerified, false);
  });
}

test("valid thinking and redacted-thinking frames before answer text preserve verification", () => {
  const c = conversation(); c.reply({}); c.reply({ applied: settings });
  c.protocol.receive({ type: "system", subtype: "init", session_id: sessionId });
  for (const content of [
    [{ type: "thinking", thinking: "synthetic", signature: "synthetic-sensitive-signature" }],
    [{ type: "redacted_thinking", data: "synthetic-sensitive-redacted-data" }],
  ]) c.protocol.receive({ type: "assistant", parent_tool_use_id: null, session_id: sessionId,
    message: { role: "assistant", model: settings.model, content } });
  answer(c, { omitInit: true }); c.reply({ applied: settings });
  const result = c.protocol.complete();
  assert.equal(result.metadata.settingsEvidence.status, "verified");
  assert.equal(result.metadata.effectiveModelVerified, true);
  assert.equal(result.metadata.effectiveEffortVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|thinking|signature/);
});

test("malformed evidence stays invalid even when a later main answer is well formed", () => {
  const c = conversation(); c.reply({}); c.reply({ applied: settings });
  c.protocol.receive({ type: "system", subtype: "init", session_id: sessionId });
  c.protocol.receive({ type: "assistant", parent_tool_use_id: null, session_id: sessionId,
    message: { role: "assistant", model: settings.model, content: 7 } });
  answer(c, { omitInit: true }); c.reply({ applied: settings });
  assert.equal(c.protocol.complete().metadata.effectiveModelVerified, false);
});

test("explicit effort or full-model mismatch is visible and cannot verify; aliases are not guessed", () => {
  for (const requested of [{ model: "claude-opus-5", effort: "high" },
    { model: "opus", effort: "medium" }]) {
    const c = conversation(requested);
    c.reply({}); c.reply({ applied: settings }); answer(c); c.reply({ applied: settings });
    const result = c.protocol.complete();
    assert.equal(result.metadata.settingsEvidence.status, "mismatch");
    assert.equal(result.metadata.effectiveModelVerified, false);
    assert.equal(result.metadata.effectiveEffortVerified, false);
  }
  assert.equal(run().metadata.settingsEvidence.requestedModelMatch, "alias_unchecked");
});

test("control errors, wrong and repeated IDs, and early result fail without raw payloads", () => {
  const frames = [
    { type: "control_response", response: { request_id: "wrong", subtype: "success",
      response: { secret: "synthetic-sensitive" } } },
    { type: "control_request", request: { secret: "synthetic-sensitive" } },
    { type: "result", subtype: "success", is_error: false, result: "synthetic-sensitive" },
  ];
  for (const frame of frames) {
    const c = conversation();
    assert.throws(() => c.protocol.receive(frame), error => {
      assert.ok(error instanceof NativeProtocolError);
      assert.doesNotMatch(error.message, /synthetic-sensitive|wrong/);
      return true;
    });
  }
  const failed = conversation();
  assert.throws(() => failed.reply({}, "error"), /could not initialize/);
  const repeated = conversation();
  const id = repeated.sent[0].request_id;
  repeated.reply({});
  assert.throws(() => repeated.protocol.receive({ type: "control_response",
    response: { subtype: "success", request_id: id } }), /unexpected control/);
});

test("duplicate init/result and assistant after result fail; notifications cannot supply evidence", () => {
  for (const late of [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId },
    { type: "assistant", message: { model: settings.model }, session_id: sessionId },
  ]) {
    const c = conversation(); c.reply({}); c.reply({ applied: settings }); answer(c);
    assert.throws(() => c.protocol.receive(late), NativeProtocolError);
  }
  const c = conversation(); c.reply({}); c.reply({ applied: settings });
  c.protocol.receive({ type: "future_notification", session_id: sessionId,
    model: settings.model, effort: "high", effectiveModelVerified: true });
  answer(c, { omitAssistant: true }); c.reply({ applied: settings });
  assert.equal(c.protocol.complete().metadata.effectiveModelVerified, false);
});
