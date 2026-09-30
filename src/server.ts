import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeRunner, inputSchema } from "./claude.js";
import type { Config } from "./config.js";

export function createServer(config: Config): {
  server: McpServer;
  runner: ClaudeRunner;
} {
  const runner = new ClaudeRunner(config);
  const server = new McpServer({ name: "claude-mcp-for-codex", version: "0.1.0" });

  server.registerTool(
    "ask_claude",
    {
      title: "Ask Claude Code",
      description:
        "Ask Claude Code for a second opinion using its existing local login. " +
        "Send only sanitized text: never credentials, secrets, or customer data. " +
        "Claude receives only the supplied prompt and cannot use tools. " +
        "For reviews, return findings and recommendations; Codex handles code changes. " +
        "Pass model/effort from applicable AGENTS.md guidance to override configured defaults. " +
        "Each call starts a fresh conversation and consumes Claude usage.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const answer = await runner.run(input, extra.signal);
        return { content: [{ type: "text", text: answer }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error
            ? error.message : "Claude request failed." }],
        };
      }
    },
  );

  return { server, runner };
}
