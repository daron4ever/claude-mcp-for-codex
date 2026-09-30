import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, waitForMarker, assertExited } from "./helpers.mjs";

async function connect(t, configuration = {}) {
  const { binary, directory } = await fixture(t);
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
      const flag = (name) => args[args.indexOf(name) + 1];
      assert.equal(flag("--tools"), "");
      assert.equal(flag("--disallowedTools"), "*");
      assert.deepEqual(JSON.parse(flag("--mcp-config")), { mcpServers: {} });
    });
  });
}

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
  assert.doesNotMatch(result.content[0].text, /synthetic-sensitive|partial answer/);
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
