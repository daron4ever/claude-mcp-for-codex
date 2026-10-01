import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { ClaudeRunner, inputSchema } from "../dist/claude.js";
import { readConfig } from "../dist/config.js";
import { fixture, waitForMarker, assertExited } from "./helpers.mjs";

function makeRunner(t, binary, timeoutMs = 5_000) {
  const runner = new ClaudeRunner({ binary, timeoutMs });
  t.after(() => runner.close());
  return runner;
}
const signal = () => new AbortController().signal;

test("configuration defaults and boundary validation", () => {
  assert.deepEqual(readConfig({}), { binary: "claude", timeoutMs: 120_000 });
  assert.deepEqual(readConfig({ CLAUDE_BIN: "/synthetic/claude", CLAUDE_TIMEOUT_MS: "1000" }),
    { binary: "/synthetic/claude", timeoutMs: 1000 });
  for (const value of ["", "0", "999", "600001", "10x", "Infinity"]) {
    assert.throws(() => readConfig({ CLAUDE_TIMEOUT_MS: value }), /Invalid configuration/);
  }
  assert.throws(() => readConfig({ CLAUDE_BIN: " " }), /Invalid configuration/);
});

test("optional configured model and effort defaults validate without echoing invalid values", () => {
  assert.deepEqual(readConfig({
    CLAUDE_DEFAULT_MODEL: "claude-opus-5-5", CLAUDE_DEFAULT_EFFORT: "medium",
  }), {
    binary: "claude", timeoutMs: 120_000,
    defaultModel: "claude-opus-5-5", defaultEffort: "medium",
  });
  assert.equal(readConfig({ CLAUDE_DEFAULT_MODEL: "best" }).defaultEffort, undefined);
  assert.equal(readConfig({ CLAUDE_DEFAULT_EFFORT: "high" }).defaultModel, undefined);
  for (const field of ["CLAUDE_DEFAULT_MODEL", "CLAUDE_DEFAULT_EFFORT"]) {
    for (const value of ["", "--tools", "synthetic-sensitive invalid value"]) {
      assert.throws(() => readConfig({ [field]: value }), (error) => {
        assert.match(error.message, /Invalid configuration/);
        assert.doesNotMatch(error.message, /synthetic-sensitive/);
        return true;
      });
    }
  }
});

test("tool input limits UTF-8 bytes and rejects empty prompts and flag-like models", () => {
  for (const prompt of ["", " \n\t", "x".repeat(100_001), "한".repeat(33_334)]) {
    assert.equal(inputSchema.safeParse({ prompt }).success, false);
  }
  assert.equal(inputSchema.safeParse({ prompt: "hi", model: "--tools" }).success, false);
  assert.deepEqual(inputSchema.parse({ prompt: "hi" }), { prompt: "hi" });
});

test("passes literal multiline text through stdin, never through a shell", async (t) => {
  const { binary } = await fixture(t);
  const runner = makeRunner(t, binary);
  const prompt = "Explain 한국어\n$(touch synthetic-file) `whoami` --resume session";
  assert.equal((await runner.run({ prompt }, signal())).answer, prompt);
});

test("launches consultation mode with customizations, tools, MCP and persistence disabled", async (t) => {
  const { binary } = await fixture(t);
  const runner = makeRunner(t, binary);
  const prompt = JSON.stringify({ scenario: "inspect" });
  const inspected = JSON.parse((await runner.run({
    prompt, model: "claude-fable-5-1", effort: "xhigh",
  }, signal())).answer);
  const args = inspected.args;
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(inspected.prompt, prompt);
  assert.ok(args.includes("--safe-mode"));
  assert.ok(!args.includes("--bare"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--disallowedTools"), "*");
  assert.equal(flag("--model"), "claude-fable-5-1");
  assert.equal(flag("--effort"), "xhigh");
  assert.equal(flag("--permission-mode"), "default");
  assert.equal(flag("--setting-sources"), "");
  assert.deepEqual(JSON.parse(flag("--mcp-config")), { mcpServers: {} });
  assert.deepEqual(JSON.parse(flag("--settings")), { disableAllHooks: true });
  assert.equal(inspected.skipHistory, "1");
});

test("concurrent effort selections stay per call and omission delegates to Claude", async (t) => {
  const { binary } = await fixture(t);
  const runner = makeRunner(t, binary);
  const efforts = [undefined, "low", "medium", "high", "xhigh", "max"];
  const results = await Promise.all(efforts.map((effort) => runner.run({
    prompt: JSON.stringify({ scenario: "inspect", effort }),
    model: "claude-fable-5-1",
    ...(effort === undefined ? {} : { effort }),
  }, signal())));
  results.forEach((result, index) => {
    const { args, prompt } = JSON.parse(result.answer);
    const effort = efforts[index];
    assert.equal(JSON.parse(prompt).effort, effort);
    const effortIndex = args.indexOf("--effort");
    if (effort === undefined) {
      assert.equal(effortIndex, -1);
    } else {
      assert.notEqual(effortIndex, -1);
      assert.equal(args[effortIndex + 1], effort);
      assert.equal(args.filter((arg) => arg === "--effort").length, 1);
    }
  });
});

test("invalid effort is rejected before attempting to start Claude Code", async (t) => {
  const { directory } = await fixture(t);
  const runner = makeRunner(t, resolve(directory, "missing"));
  for (const effort of ["", "auto", "ultracode", "--tools", "XHIGH", "xhigh ", null, 1]) {
    await assert.rejects(runner.run({ prompt: "review", effort }, signal()), (error) => {
      assert.equal(error.name, "ZodError");
      assert.ok(error.issues.some((issue) => issue.path.includes("effort")));
      return true;
    });
  }
});

test("missing executable produces a safe actionable failure", async (t) => {
  const { directory } = await fixture(t);
  const runner = makeRunner(t, resolve(directory, "missing"));
  await assert.rejects(runner.run({ prompt: "hi" }, signal()), /Could not start Claude Code/);
});

for (const scenario of ["error", "invalid", "invalid-utf8", "envelope-error", "empty",
  "stdout-overflow", "stderr-overflow"]) {
  test(`handles ${scenario} without returning raw diagnostics or partial output`, async (t) => {
    const { binary } = await fixture(t);
    const runner = makeRunner(t, binary);
    await assert.rejects(runner.run({ prompt: JSON.stringify({ scenario }) }, signal()), (error) => {
      assert.match(error.message, /Claude/);
      assert.doesNotMatch(error.message, /synthetic-sensitive|partial answer|xxxx/);
      return true;
    });
    assert.equal((await runner.run({ prompt: "subsequent request works" }, signal())).answer,
      "subsequent request works");
  });
}

test("already cancelled requests do not start the executable", async (t) => {
  const { directory } = await fixture(t);
  const runner = makeRunner(t, resolve(directory, "missing"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.run({ prompt: "hi" }, controller.signal), /cancelled/);
});

for (const scenario of ["hang", "ignore-term"]) {
  test(`timeout terminates ${scenario} child before returning`, async (t) => {
    const { binary, directory } = await fixture(t);
    const runner = makeRunner(t, binary, 1_000);
    const marker = resolve(directory, "ready");
    const request = runner.run({ prompt: JSON.stringify({ scenario, marker }) }, signal());
    const rejected = assert.rejects(request, /timed out/);
    const pid = await waitForMarker(marker);
    await rejected;
    assertExited(assert, pid);
  });
}

test("cancellation terminates an active request and leaves other calls usable", async (t) => {
  const { binary, directory } = await fixture(t);
  const runner = makeRunner(t, binary);
  const marker = resolve(directory, "ready");
  const controller = new AbortController();
  const request = runner.run({ prompt: JSON.stringify({ scenario: "ignore-term", marker }) },
    controller.signal);
  const rejected = assert.rejects(request, /cancelled/);
  const pid = await waitForMarker(marker);
  controller.abort();
  await rejected;
  assertExited(assert, pid);
  assert.equal((await runner.run({ prompt: "another request" }, signal())).answer, "another request");
});

test("a descendant holding stdout cannot keep a timed-out request alive", async (t) => {
  const { binary, directory } = await fixture(t);
  const runner = makeRunner(t, binary, 1_000);
  const marker = resolve(directory, "ready");
  const rejected = assert.rejects(runner.run({ prompt: JSON.stringify({
    scenario: "descendant", marker,
  }) }, signal()), /timed out/);
  await waitForMarker(marker);
  await rejected;
});

test("concurrent requests keep answers separate", async (t) => {
  const { binary } = await fixture(t);
  const runner = makeRunner(t, binary);
  const results = await Promise.all(["first", "second", "third"].map((prompt) =>
    runner.run({ prompt }, signal())));
  assert.deepEqual(results.map((result) => result.answer), ["first", "second", "third"]);
});

test("shutdown terminates all active children and prevents new calls", async (t) => {
  const { binary, directory } = await fixture(t);
  const runner = makeRunner(t, binary);
  const markers = [resolve(directory, "one"), resolve(directory, "two")];
  const rejected = markers.map((marker) => assert.rejects(runner.run({
    prompt: JSON.stringify({ scenario: "ignore-term", marker }),
  }, signal()), /cancelled/));
  const pids = await Promise.all(markers.map(waitForMarker));
  await runner.close();
  await Promise.all(rejected);
  pids.forEach((pid) => assertExited(assert, pid));
  await assert.rejects(runner.run({ prompt: "hi" }, signal()), /cancelled/);
  await runner.close();
});
