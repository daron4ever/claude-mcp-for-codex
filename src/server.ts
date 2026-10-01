import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeRunner, inputSchema, outputSchema } from "./claude.js";
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
        "Successful calls include requested settings and CLI-reported model IDs; " +
        "effective model and effort remain unverified. " +
        "Each call starts a fresh conversation and consumes Claude usage.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const result = await runner.run(input, extra.signal);
        return {
          content: [
            { type: "text", text: result.answer },
            { type: "text", text: "Claude execution metadata (effective settings unverified):\n" +
              JSON.stringify(result.metadata) },
          ],
          structuredContent: result,
        };
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
