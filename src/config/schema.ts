import { z } from "zod";

export const BudgetConfigSchema = z.object({
  /** Spending cap per PR review in USD, computed from DeepSeek pricing (0 = unlimited). */
  maxCostUsd: z.coerce.number().min(0).default(1),
  /** Context window used for memory compression; not a spending limit. */
  maxContextTokens: z.coerce.number().positive().default(128_000),
  softWatermark: z.number().min(0).max(1).default(0.6),
  warningWatermark: z.number().min(0).max(1).default(0.8),
  roundTimeoutMs: z.coerce.number().positive().default(300_000),
  totalTimeoutMs: z.coerce.number().positive().default(1_800_000),
});

/** Safety limits: backstops against runaway loops, not spending controls. */
export const LimitsConfigSchema = z.object({
  /** Max ReAct rounds per file group before a forced Grace Round. */
  maxRounds: z.coerce.number().int().positive().default(100),
});

export const TelemetryConfigSchema = z.object({
  enabled: z.coerce.boolean().default(true),
  phoenixEndpoint: z.string().url().default("http://localhost:6006/v1/traces"),
  serviceName: z.string().default("pr-agent"),
});

export const ReviewPolicySchema = z.object({
  minSeverityToBlock: z.enum(["P0", "P1", "P2", "P3"]).default("P1"),
  maxCommentsPerReview: z.coerce.number().int().positive().default(30),
  enableAstGrep: z.coerce.boolean().default(true),
});

export const PRAgentConfigSchema = z.object({
  model: z.string().default("deepseek-flash"),
  apiKey: z.string().optional(),
  baseURL: z.string().url().default("https://api.deepseek.com"),
  temperature: z.coerce.number().min(0).max(2).default(0.1),
  budget: BudgetConfigSchema.default({}),
  limits: LimitsConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  review: ReviewPolicySchema.default({}),
  rules: z.array(z.string()).default([]),
});

export type PRAgentConfig = z.infer<typeof PRAgentConfigSchema>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type PRAgentUserConfig = DeepPartial<PRAgentConfig>;

/**
 * Type-safe configuration helper for pr-agent.config.ts
 */
export function defineConfig(config: PRAgentUserConfig): PRAgentUserConfig {
  return config;
}
