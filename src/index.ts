#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("This server supports macOS and Linux. Use WSL on Windows.");
  }
  const { server, runner } = createServer(readConfig(process.env));
  let shutdownPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await runner.close();
      await server.close();
    })();
    return shutdownPromise;
  };
  server.server.onclose = () => { void stop(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().then(() => process.exit(0), () => process.exit(1));
    });
  }
  process.stdin.once("end", () => { void stop(); });
  process.stdout.on("error", () => { void stop(); });
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  console.error(
    "Could not start claude-mcp-for-codex. Use macOS/Linux and check " +
      "CLAUDE_BIN, CLAUDE_TIMEOUT_MS, CLAUDE_DEFAULT_MODEL, and " +
      "CLAUDE_DEFAULT_EFFORT configuration.",
  );
  process.exitCode = 1;
});
