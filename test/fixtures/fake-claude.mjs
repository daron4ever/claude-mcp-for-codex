#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
let request;
try { request = JSON.parse(prompt); } catch { request = { scenario: "echo" }; }

const success = (result) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result,
});
const ready = () => {
  if (request.marker) writeFileSync(request.marker, String(process.pid));
};

switch (request.scenario) {
  case "hang":
    ready();
    setInterval(() => {}, 1000);
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {
      if (request.termMarker) writeFileSync(request.termMarker, String(process.pid));
    });
    ready();
    setInterval(() => {}, 1000);
    break;
  case "descendant": {
    const child = spawn(process.execPath, ["-e", [
      'process.on("SIGTERM", () => {});',
      'process.send("ready");',
      'setInterval(() => {}, 1000);',
    ].join("\n")], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.once("message", () => {
      ready();
      process.stdout.write(success("answer before descendant exits"));
      process.exit();
    });
    break;
  }
  case "error":
    process.stderr.write("synthetic-sensitive-diagnostic");
    process.stdout.write(success("partial answer must not be returned"));
    process.exitCode = 1;
    break;
  case "invalid":
    process.stdout.write("synthetic-sensitive-invalid-json");
    break;
  case "invalid-utf8":
    process.stdout.write(Buffer.from([0xc3, 0x28]));
    break;
  case "envelope-error":
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true,
      result: "synthetic-sensitive-error-result",
    }));
    break;
  case "empty":
    process.stdout.write(success(""));
    break;
  case "stdout-overflow":
    process.stdout.write("x".repeat(1_048_577));
    break;
  case "stderr-overflow":
    process.stderr.write("x".repeat(65_537));
    process.stdout.write(success("answer"));
    break;
  case "inspect":
    process.stdout.write(success(JSON.stringify({
      prompt,
      args: process.argv.slice(2),
      apiKeyPassed: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
      unrelatedSecretPassed: Object.hasOwn(process.env, "SYNTHETIC_SECRET"),
      skipHistory: process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY,
    })));
    break;
  default:
    process.stdout.write(success(prompt));
}
