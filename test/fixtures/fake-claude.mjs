#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const fixtureOptions = {};
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const aliases = {
  opus: "claude-opus-5-5", sonnet: "claude-sonnet-4-5", haiku: "claude-haiku-4-5",
  best: "claude-fable-5-1", fable: "claude-fable-5-1",
};
const selected = args.includes("--model") ? flag("--model") : "opus";
const applied = {
  model: aliases[selected] ?? selected,
  effort: args.includes("--effort") ? flag("--effort") : "medium",
};
const session = "synthetic-sensitive-session-" + process.pid;
let prompt = "", request = {}, initialized = 0, settingsReads = 0, userMessages = 0;
let initializePayload;
let output = Promise.resolve();
const fault = () => fixtureOptions.fault ?? request.fault;
const hold = () => setInterval(() => {}, 1000);
const ready = () => {
  const marker = fixtureOptions.marker ?? request.marker;
  if (marker) writeFileSync(marker, String(process.pid));
};
function emit(frame) {
  const data = Buffer.from(JSON.stringify(frame) + "\r\n");
  if (request.chunked || fixtureOptions.chunked) {
    output = output.then(async () => {
      for (let i = 0; i < data.length; i += 7) {
        process.stdout.write(data.subarray(i, i + 7));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
  } else process.stdout.write(data);
}
function control(frame, payload, subtype = "success", id = frame.request_id) {
  emit({ type: "control_response", response: {
    subtype, request_id: id, response: payload,
    error: "synthetic-sensitive-control-error",
  } });
}
function assistant(text, fields = {}) {
  emit({ type: "assistant", parent_tool_use_id: null, session_id: session,
    message: { role: "assistant", model: request.answerModel ?? applied.model,
      content: [{ type: "text", text }] }, ...fields });
}
function answer(text, fields = {}) {
  if (fault() !== "missing-init") {
    emit({ type: "system", subtype: "init", session_id:
      fault() === "init-session-mismatch" ? "synthetic-other-session" : session });
  }
  if (fault() === "duplicate-init") emit({ type: "system", subtype: "init", session_id: session });
  if (fault() !== "missing-assistant") {
    const message = { role: "assistant", model: request.answerModel ?? applied.model,
      content: [{ type: "text", text }] };
    const evidenceFaults = {
      "missing-assistant-parent": { parent_tool_use_id: undefined },
      "missing-assistant-role": { message: { ...message, role: undefined } },
      "wrong-assistant-role": { message: { ...message, role: "user" } },
      "missing-assistant-content": { message: { ...message, content: undefined } },
      "scalar-assistant-content": { message: { ...message, content: 7 } },
      "empty-assistant-content": { message: { ...message, content: [] } },
      "thinking-only": { message: { ...message,
        content: [{ type: "thinking", thinking: "synthetic-sensitive-thinking" }] } },
    };
    assistant(text, fault() === "assistant-session-mismatch" ? { session_id: "synthetic-other-session" } :
      fault() === "auxiliary-only" ? { parent_tool_use_id: "synthetic-sidechain" } :
        fault() === "missing-assistant-session" ? { session_id: undefined } :
          evidenceFaults[fault()] ?? {});
  }
  if (fault() === "multiple-models") assistant("other", { message: {
    role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "other" }],
  } });
  const result = { type: "result", subtype: "success", is_error: false,
    result: text, session_id: fault() === "result-session-mismatch" ? "synthetic-other-session" : session,
    ...fields };
  emit(result);
  if (fault() === "duplicate-result") emit(result);
  if (fault() === "late-assistant") assistant("late");
  if (fault() === "result-then-invalid") process.stdout.write("synthetic-sensitive-invalid-json\n");
}
function runPrompt() {
  switch (request.scenario) {
    case "output-hang":
      assistant("synthetic-sensitive partial answer");
      process.stderr.write("synthetic-sensitive diagnostics");
      ready(); hold(); break;
    case "hang": ready(); hold(); break;
    case "ignore-term":
      process.on("SIGTERM", () => {
        if (request.termMarker) writeFileSync(request.termMarker, String(process.pid));
      });
      ready(); hold(); break;
    case "descendant": {
      const child = spawn(process.execPath, ["-e", [
        'process.on("SIGTERM", () => {});',
        'process.send("ready");',
        'setInterval(() => {}, 1000);',
      ].join("\n")], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      child.once("message", () => {
        if (request.childMarker) writeFileSync(request.childMarker, String(child.pid));
        ready(); assistant("answer before descendant exits"); process.exit();
      });
      break;
    }
    case "error":
      process.stderr.write("synthetic-sensitive-diagnostic");
      answer("partial answer must not be returned", {
        modelUsage: { "claude-opus-5": { sensitive: "synthetic-sensitive-usage" } },
      });
      process.exitCode = 1; break;
    case "invalid": process.stdout.write("synthetic-sensitive-invalid-json\n"); break;
    case "invalid-utf8": process.stdout.write(Buffer.from([0xc3, 0x28])); break;
    case "envelope-error":
      emit({ type: "result", subtype: "error_during_execution", is_error: true,
        result: "synthetic-sensitive-error-result" }); break;
    case "empty": answer(""); break;
    case "stdout-overflow": process.stdout.write("x".repeat(1_048_577)); break;
    case "stderr-overflow": process.stderr.write("x".repeat(65_537)); answer("answer"); break;
    case "large-answer": answer("x".repeat(600_000)); break;
    case "inspect":
      answer(JSON.stringify({ prompt, args,
        apiKeyPassed: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
        unrelatedSecretPassed: Object.hasOwn(process.env, "SYNTHETIC_SECRET"),
        skipHistory: process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY,
        initializePayload, initialized, userMessages, settingsReads,
      })); break;
    case "metadata": answer("metadata answer", request.fields); break;
    case "tool-request":
      emit({ type: "control_request", request_id: "synthetic-permission", request: {
        subtype: "can_use_tool", tool_name: "Bash", input: { secret: "synthetic-sensitive" },
      } }); hold(); break;
    case "tool-use":
      assistant("", { message: { model: applied.model, content: [{ type: "tool_use", name: "Bash" }] } });
      hold(); break;
    default: answer(prompt);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request.subtype === "initialize") {
    initialized++; initializePayload = frame.request;
    if (fault() === "initialize-hang") { ready(); hold(); return; }
    if (fault() === "initialize-error") { control(frame, {}, "error"); return; }
    if (fault() === "result-before-prompt") { answer("unexpected"); return; }
    control(frame, {}, "success", fault() === "wrong-id" ? "synthetic-wrong-id" : frame.request_id);
    if (fault() === "duplicate-control") control(frame, {});
  } else if (frame.type === "control_request" && frame.request.subtype === "get_settings") {
    settingsReads++;
    const position = settingsReads === 1 ? "before" : "after";
    if (fault() === position + "-hang") { ready(); hold(); return; }
    if (fault() === position + "-exit") { process.exit(); return; }
    if (fault() === position + "-error") { control(frame, {}, "error"); return; }
    if (fault() === position + "-overflow") { process.stdout.write("x".repeat(1_048_577)); return; }
    const value = fixtureOptions[position] ?? request[position] ?? applied;
    const payload = { applied: value, settings: { secret: "synthetic-sensitive-settings" } };
    if (fault() === position + "-missing") delete payload.applied;
    control(frame, payload);
    if (position === "after" && fault() === "truncated-utf8") process.stdout.write(Buffer.from([0xc3]));
    if (position === "after" && fault() === "unterminated-line") process.stdout.write("{");
    if (fault() === "closing-hang" && position === "after") { ready(); hold(); }
  } else if (frame.type === "user") {
    userMessages++; prompt = frame.message.content;
    try { request = JSON.parse(prompt); } catch { request = { scenario: "echo" }; }
    runPrompt();
  } else { process.exitCode = 1; lines.close(); }
});
lines.on("close", () => {
  if (request.trace) writeFileSync(request.trace, JSON.stringify({
    initialized, settingsReads, userMessages, initializePayload,
  }));
});
