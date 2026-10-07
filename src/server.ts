import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeExecutionError, ClaudeRunner, inputSchema, outputSchema } from "./claude.js";
import type { Config } from "./config.js";
import { progressMessage } from "./progress.js";

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
        "Successful calls include requested settings, aggregate model IDs and " +
        "answer-correlated CLI-applied settings evidence. Verification flags cover " +
        "only CLI-applied session settings, not provider attestation or reasoning allocation. " +
        "Missing or mismatched evidence leaves the answer unverified. " +
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
      const token = extra._meta?.progressToken;
      const hasToken = typeof token === "string" ||
        typeof token === "number" && Number.isInteger(token);
      let active = true;
      let sequence = 0;
      try {
        const result = await runner.run(input, extra.signal, hasToken ? (progress) => {
          if (!active) return;
          return extra.sendNotification({ method: "notifications/progress", params: {
            progressToken: token, progress: ++sequence, message: progressMessage(progress),
          } });
        } : undefined);
        return {
          content: [
            { type: "text", text: result.answer },
            { type: "text", text: "Claude execution metadata (CLI-applied settings " +
              result.metadata.settingsEvidence.status + "; provider attestation unavailable):\n" +
              JSON.stringify(result.metadata) },
          ],
          structuredContent: result,
        };
      } catch (error) {
        const message: { type: "text"; text: string } = {
          type: "text",
          text: error instanceof Error ? error.message : "Claude request failed.",
        };
        const content = [message];
        if (error instanceof ClaudeExecutionError) {
          const diagnostics = error.diagnostics;
          message.text += "\n" + progressMessage(diagnostics) +
            ` exit=${diagnostics.exitObserved ? "yes" : "no"}` +
            ` close=${diagnostics.closeObserved ? "yes" : "no"}` +
            ` cleanup=${diagnostics.cleanupStatus}`;
          content.push({
            type: "text",
            text: "Claude failure diagnostics (initial state before cleanup):\n" +
              JSON.stringify(error.diagnostics),
          });
        }
        return {
          isError: true,
          content,
        };
      } finally {
        active = false;
      }
    },
  );

  return { server, runner };
}
