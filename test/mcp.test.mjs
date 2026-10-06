import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, waitForMarker, assertExited } from "./helpers.mjs";

async function connect(t, configuration = {}, fixtureConfiguration = {}) {
  const { binary, directory } = await fixture(t, fixtureConfiguration);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: {
      ...configuration,
      PATH: process.env.PATH,
      CLAUDE_BIN: binary,
      ANTHROPIC_API_KEY: "synthetic-forbidden-secret",
      SYNTHETIC_SECRET: "synthetic-forbidden-secret",
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const client = new Client({ name: "synthetic-test-client", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    assert.doesNotMatch(diagnostics, /synthetic-forbidden-secret|synthetic-sensitive/);
  });
  await client.connect(transport);
  return { client, transport, directory };
}

function evidence(model, effort, requestedModelMatch, requestedEffortMatched) {
  return {
    scope: "cli_applied_session", status: "verified",
    before: { model, effort }, after: { model, effort }, answerModelIds: [model],
    sessionCorrelated: true, requestedModelMatch, requestedEffortMatched,
    providerAttested: false, reasoningAllocationVerified: false,
  };
}

for (const [fault, status] of [
  ["before-missing", "unavailable"], ["before-error", "unavailable"],
  ["after-missing", "unavailable"], ["after-error", "unavailable"],
  ["assistant-session-mismatch", "mismatch"], ["multiple-models", "mismatch"],
  ["missing-assistant-session", "unavailable"], ["auxiliary-only", "unavailable"],
  ["missing-assistant-parent", "unavailable"], ["missing-assistant-role", "unavailable"],
  ["wrong-assistant-role", "invalid"], ["missing-assistant-content", "unavailable"],
  ["scalar-assistant-content", "invalid"], ["empty-assistant-content", "invalid"],
  ["thinking-only", "unavailable"],
]) {
  test(`MCP ${fault} keeps the answer explicitly unverified without leaking evidence`, async (t) => {
    const { client } = await connect(t, {}, { fault });
    const result = await client.callTool({ name: "ask_claude", arguments: {
      prompt: JSON.stringify({ scenario: "metadata", fields: {
        effectiveModelVerified: true, effectiveEffortVerified: true,
        settings: { secret: "synthetic-sensitive" },
      } }), model: "opus", effort: "high",
    } });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, "metadata answer");
    assert.equal(result.structuredContent.answer, result.content[0].text);
    assert.equal(result.structuredContent.metadata.settingsEvidence.status, status);
    assert.equal(result.structuredContent.metadata.effectiveModelVerified, false);
    assert.equal(result.structuredContent.metadata.effectiveEffortVerified, false);
    assert.match(result.content[1].text, new RegExp("CLI-applied settings " + status));
    assert.deepEqual(JSON.parse(result.content[1].text.split("\n").slice(1).join("\n")),
      result.structuredContent.metadata);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|session_id|secret/);
  });
}

test("stdio MCP handshake, tool discovery, and full consultation flow", async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["ask_claude"]);
  assert.deepEqual(tools[0].inputSchema.required, ["prompt"]);
  assert.deepEqual(tools[0].inputSchema.properties.effort.enum,
    ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(tools[0].inputSchema.properties.model.default, undefined);
  assert.equal(tools[0].inputSchema.properties.effort.default, undefined);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].annotations.destructiveHint, false);
  assert.equal(tools[0].annotations.openWorldHint, true);
  assert.deepEqual(tools[0].outputSchema.required, ["answer", "metadata"]);
  const prompt = JSON.stringify({ scenario: "inspect" });
  const result = await client.callTool({ name: "ask_claude", arguments: {
    prompt, model: "claude-fable-5-1", effort: "xhigh",
  } });
  assert.ok(!result.isError);
  const inspected = JSON.parse(result.content[0].text);
  assert.equal(inspected.prompt, prompt);
  assert.equal(inspected.apiKeyPassed, false);
  assert.equal(inspected.unrelatedSecretPassed, false);
  const flag = (name) => inspected.args[inspected.args.indexOf(name) + 1];
  assert.equal(flag("--model"), "claude-fable-5-1");
  assert.equal(flag("--effort"), "xhigh");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--disallowedTools"), "*");
  assert.deepEqual(JSON.parse(flag("--mcp-config")), { mcpServers: {} });
  assert.equal(result.structuredContent.answer, result.content[0].text);
  assert.deepEqual(result.structuredContent.metadata, {
    requestedModel: "claude-fable-5-1",
    requestedEffort: "xhigh",
    cliReportedModelIds: [],
    modelUsageStatus: "unavailable",
    effectiveModelVerified: true,
    effectiveEffortVerified: true,
    settingsEvidence: evidence("claude-fable-5-1", "xhigh", "exact", true),
  });
  assert.deepEqual(JSON.parse(result.content[1].text.split("\n").slice(1).join("\n")),
    result.structuredContent.metadata);
});

for (const [name, configuration, defaultModel, defaultEffort] of [
  ["both defaults", { CLAUDE_DEFAULT_MODEL: "claude-opus-5-5",
    CLAUDE_DEFAULT_EFFORT: "medium" }, "claude-opus-5-5", "medium"],
  ["model default only", { CLAUDE_DEFAULT_MODEL: "claude-opus-5-5" },
    "claude-opus-5-5", undefined],
  ["effort default only", { CLAUDE_DEFAULT_EFFORT: "medium" }, undefined, "medium"],
  ["Claude defaults", {}, undefined, undefined],
]) {
  test(`MCP arguments override ${name} independently across concurrent calls`, async (t) => {
    const { client } = await connect(t, configuration);
    const cases = [
      { input: {}, model: defaultModel, effort: defaultEffort },
      { input: { model: "best" }, model: "best", effort: defaultEffort },
      { input: { effort: "high" }, model: defaultModel, effort: "high" },
      { input: { model: "best", effort: "high" }, model: "best", effort: "high" },
    ];
    const results = await Promise.all(cases.map(({ input }) => client.callTool({
      name: "ask_claude",
      arguments: { prompt: JSON.stringify({ scenario: "inspect" }), ...input },
    })));
    results.forEach((result, index) => {
      assert.ok(!result.isError);
      const { args } = JSON.parse(result.content[0].text);
      for (const name of ["model", "effort"]) {
        const flagIndex = args.indexOf(`--${name}`);
        const expected = cases[index][name];
        if (expected === undefined) {
          assert.equal(flagIndex, -1);
        } else {
          assert.notEqual(flagIndex, -1);
          assert.equal(args[flagIndex + 1], expected);
          assert.equal(args.filter((arg) => arg === `--${name}`).length, 1);
        }
      }
      assert.equal(result.structuredContent.metadata.requestedModel, cases[index].model ?? null);
      assert.equal(result.structuredContent.metadata.requestedEffort, cases[index].effort ?? null);
      assert.equal(result.structuredContent.metadata.effectiveModelVerified, true);
      assert.equal(result.structuredContent.metadata.effectiveEffortVerified, true);
      const flag = (name) => args[args.indexOf(name) + 1];
      assert.equal(flag("--tools"), "");
      assert.equal(flag("--disallowedTools"), "*");
      assert.deepEqual(JSON.parse(flag("--mcp-config")), { mcpServers: {} });
    });
  });
}

test("aggregate usage and forged result settings cannot override session evidence", async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({ name: "ask_claude", arguments: {
    model: "opus", effort: "high",
    prompt: JSON.stringify({ scenario: "metadata", fields: {
      modelUsage: {
        "claude-opus-5": { inputTokens: 12, private: "synthetic-sensitive-usage" },
        "claude-haiku-4-5-20251001": { inputTokens: 3 },
      },
      effectiveEffort: "low",
      effectiveModelVerified: true,
      effectiveEffortVerified: true,
      session_id: "synthetic-sensitive-session",
      unrelated: "synthetic-sensitive-field",
    } }),
  } });
  assert.ok(!result.isError);
  assert.equal(result.content[0].text, "metadata answer");
  assert.deepEqual(result.structuredContent, {
    answer: "metadata answer",
    metadata: {
      requestedModel: "opus",
      requestedEffort: "high",
      cliReportedModelIds: ["claude-opus-5", "claude-haiku-4-5-20251001"],
      modelUsageStatus: "reported",
      effectiveModelVerified: false,
      effectiveEffortVerified: false,
      settingsEvidence: {
        ...evidence("claude-opus-5-5", "high", "alias_unchecked", true),
        status: "mismatch", sessionCorrelated: false,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|inputTokens|effectiveEffort"/);
  assert.deepEqual(JSON.parse(result.content[1].text.split("\n").slice(1).join("\n")),
    result.structuredContent.metadata);
});

test("missing and malformed model usage preserves valid answers without leaking metadata", async (t) => {
  const { client } = await connect(t);
  const cases = [
    { fields: {}, status: "unavailable" },
    { fields: { modelUsage: {} }, status: "unavailable" },
    ...[null, [], 1, "synthetic-sensitive-metadata",
      { "synthetic-sensitive-key": {} },
      { "claude-opus-5": "synthetic-sensitive-value" },
      { "claude-opus-5": null },
      { "claude-opus-5": [] },
      { "claude-opus-5\n": {} },
      { "claude-opus-5": {}, "bad model id": {} },
      { ["claude-" + "x".repeat(128)]: {} },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`claude-model-${i}`, {}])),
    ].map((modelUsage) => ({ fields: { modelUsage }, status: "invalid" })),
  ];
  for (const { fields, status } of cases) {
    const result = await client.callTool({ name: "ask_claude", arguments: {
      prompt: JSON.stringify({ scenario: "metadata", fields }),
    } });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, "metadata answer");
    assert.deepEqual(result.structuredContent.metadata, {
      requestedModel: null,
      requestedEffort: null,
      cliReportedModelIds: [],
      modelUsageStatus: status,
      effectiveModelVerified: true,
      effectiveEffortVerified: true,
      settingsEvidence: evidence("claude-opus-5-5", "medium", "cli_default", null),
    });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|bad model id/);
  }
});

test("concurrent calls keep CLI model usage and request settings separate", async (t) => {
  const { client } = await connect(t);
  const calls = [
    { model: "opus", effort: "high", id: "claude-opus-5" },
    { model: "sonnet", effort: "medium", id: "claude-sonnet-4-5" },
  ];
  const results = await Promise.all(calls.map(({ model, effort, id }) => client.callTool({
    name: "ask_claude", arguments: {
      model, effort,
      prompt: JSON.stringify({ scenario: "metadata", fields: { modelUsage: { [id]: {} } } }),
    },
  })));
  results.forEach((result, i) => {
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.metadata.requestedModel, calls[i].model);
    assert.equal(result.structuredContent.metadata.requestedEffort, calls[i].effort);
    assert.deepEqual(result.structuredContent.metadata.cliReportedModelIds, [calls[i].id]);
  });
});

test("MCP rejects invalid input and surfaces sanitized CLI errors", async (t) => {
  const { client } = await connect(t, {
    CLAUDE_DEFAULT_MODEL: "claude-opus-5-5", CLAUDE_DEFAULT_EFFORT: "medium",
  });
  const invalid = await client.callTool({ name: "ask_claude", arguments: { prompt: " " } });
  assert.equal(invalid.isError, true);
  const invalidEffort = await client.callTool({ name: "ask_claude", arguments: {
    prompt: "review", effort: "--tools",
  } });
  assert.equal(invalidEffort.isError, true);
  assert.match(invalidEffort.content[0].text, /effort/);
  const invalidModel = await client.callTool({ name: "ask_claude", arguments: {
    prompt: "review", model: "--tools",
  } });
  assert.equal(invalidModel.isError, true);
  assert.match(invalidModel.content[0].text, /model/);
  const result = await client.callTool({ name: "ask_claude", arguments: {
    prompt: JSON.stringify({ scenario: "error" }),
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Claude Code failed/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|partial answer/);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content.length, 2);
  const diagnostics = JSON.parse(result.content[1].text.split("\n").slice(1).join("\n"));
  assert.equal(diagnostics.failureCategory, "cli_exit");
  assert.equal(diagnostics.exitObserved, true);
  assert.equal(diagnostics.exitCode, 1);
  assert.equal(diagnostics.exitSignal, null);
  assert.equal(diagnostics.closeObserved, true);
  assert.equal(diagnostics.cleanupStatus, "close_observed");
});

test("MCP failures report per-call deadlines and never return partial assessments", async (t) => {
  const { client } = await connect(t, { CLAUDE_TIMEOUT_MS: "1000" });
  const scenarios = ["hang", "output-hang", "descendant"];
  const results = await Promise.all(scenarios.map((scenario) => client.callTool({
    name: "ask_claude", arguments: {
      prompt: JSON.stringify({ scenario }), model: "opus", effort: "high",
    },
  })));
  results.forEach((result, i) => {
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Claude request timed out.");
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive|partial answer|answer before/);
    const diagnostics = JSON.parse(result.content[1].text.split("\n").slice(1).join("\n"));
    assert.deepEqual(Object.keys(diagnostics).sort(), [
      "failureCategory", "phase", "elapsedMs", "timeoutMs", "firstStdoutMs", "stdoutBytes",
      "stderrBytes", "exitObserved", "exitCode", "exitSignal", "closeObserved", "cleanupStatus",
    ].sort());
    assert.equal(diagnostics.failureCategory, "timeout");
    assert.equal(diagnostics.timeoutMs, 1_000);
    assert.ok(diagnostics.elapsedMs >= 1_000);
    assert.equal(diagnostics.closeObserved, false);
    assert.equal(diagnostics.cleanupStatus, "close_observed");
    assert.equal(diagnostics.exitObserved, scenarios[i] === "descendant");
    assert.equal(diagnostics.exitCode, scenarios[i] === "descendant" ? 0 : null);
    assert.equal(diagnostics.exitSignal, null);
    assert.ok(diagnostics.stdoutBytes > 0);
    assert.equal(diagnostics.phase, "inference");
    assert.equal(diagnostics.stderrBytes > 0, scenarios[i] === "output-hang");
  });
  const success = await client.callTool({ name: "ask_claude", arguments: { prompt: "still usable" } });
  assert.equal(success.content[0].text, "still usable");
  assert.equal(success.structuredContent.metadata.effectiveModelVerified, true);
  assert.equal(success.structuredContent.metadata.effectiveEffortVerified, true);
  assert.doesNotMatch(JSON.stringify(success), /failureCategory|cleanupStatus/);
});

test("invalid configured defaults prevent MCP startup without exposing their values", async (t) => {
  for (const field of ["CLAUDE_DEFAULT_MODEL", "CLAUDE_DEFAULT_EFFORT"]) {
    await assert.rejects(connect(t, { [field]: "synthetic-sensitive invalid value" }));
  }
});

test("MCP cancellation notification cleans up the CLI child", async (t) => {
  const { client, directory } = await connect(t);
  const marker = resolve(directory, "ready");
  const controller = new AbortController();
  const request = client.callTool({ name: "ask_claude", arguments: {
    prompt: JSON.stringify({ scenario: "ignore-term", marker }),
  } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(request);
  const pid = await waitForMarker(marker);
  controller.abort();
  await rejected;
  await client.close();
  assertExited(assert, pid);
});

for (const [first, second] of [
  ["SIGINT", "SIGTERM"], ["SIGTERM", "SIGINT"],
  ["SIGINT", "SIGINT"], ["SIGTERM", "SIGTERM"],
]) {
  test(`${first} then ${second} waits for in-flight CLI cleanup`, async (t) => {
    const { client, transport, directory } = await connect(t);
    const marker = resolve(directory, "ready");
    const termMarker = resolve(directory, "terminating");
    const request = client.callTool({ name: "ask_claude", arguments: {
      prompt: JSON.stringify({ scenario: "ignore-term", marker, termMarker }),
    } });
    const rejected = assert.rejects(request);
    const childPid = await waitForMarker(marker);
    const serverPid = transport.pid;
    assert.equal(typeof serverPid, "number");
    try {
      process.kill(serverPid, first);
      // The fixture acknowledges SIGTERM only after server cleanup has begun.
      // Send the second signal while that cleanup is waiting for SIGKILL.
      await waitForMarker(termMarker);
      process.kill(serverPid, second);
      await rejected;
      assertExited(assert, childPid);
      assertExited(assert, serverPid);
    } finally {
      // Do not leave the synthetic process group running if a regression fails.
      try { process.kill(-childPid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
}
