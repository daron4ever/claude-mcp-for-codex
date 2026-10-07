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
