import { z } from "zod";

export const modelSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const configSchema = z.object({
  CLAUDE_BIN: z.string().trim().min(1)
    .refine((value) => !value.includes("\0"))
    .default("claude"),
  CLAUDE_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(600_000))
    .default(120_000),
  CLAUDE_DEFAULT_MODEL: modelSchema.optional(),
  CLAUDE_DEFAULT_EFFORT: effortSchema.optional(),
});

export interface Config {
  binary: string;
  timeoutMs: number;
  defaultModel?: string;
  defaultEffort?: z.infer<typeof effortSchema>;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse({
    CLAUDE_BIN: env.CLAUDE_BIN,
    CLAUDE_TIMEOUT_MS: env.CLAUDE_TIMEOUT_MS,
    CLAUDE_DEFAULT_MODEL: env.CLAUDE_DEFAULT_MODEL,
    CLAUDE_DEFAULT_EFFORT: env.CLAUDE_DEFAULT_EFFORT,
  });
  if (!result.success) {
    throw new Error(
      "Invalid configuration. CLAUDE_BIN must be an executable name or path; " +
        "CLAUDE_TIMEOUT_MS must be an integer between 1000 and 600000; " +
        "CLAUDE_DEFAULT_MODEL must be a model alias or ID; " +
        "CLAUDE_DEFAULT_EFFORT must be low, medium, high, xhigh, or max.",
    );
  }
  return {
    binary: result.data.CLAUDE_BIN,
    timeoutMs: result.data.CLAUDE_TIMEOUT_MS,
    ...(result.data.CLAUDE_DEFAULT_MODEL === undefined ? {} : {
      defaultModel: result.data.CLAUDE_DEFAULT_MODEL,
    }),
    ...(result.data.CLAUDE_DEFAULT_EFFORT === undefined ? {} : {
      defaultEffort: result.data.CLAUDE_DEFAULT_EFFORT,
    }),
  };
}
