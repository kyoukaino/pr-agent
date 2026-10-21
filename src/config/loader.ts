import { loadConfig as c12LoadConfig } from "c12";
import { PRAgentConfigSchema, type PRAgentConfig, type PRAgentUserConfig } from "./schema.js";

export interface LoadConfigOptions {
  cwd?: string;
  configFile?: string;
  overrides?: PRAgentUserConfig;
}

export interface LoadedConfigResult {
  config: PRAgentConfig;
  configFile?: string;
}

/**
 * Deep merge utility that ignores undefined values, preventing shallow object spread
 * from overriding resolved values with undefined.
 */
function deepMergeClean<T extends Record<string, unknown>>(
  ...sources: (Record<string, unknown> | undefined)[]
): T {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMergeClean(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result as T;
}

/**
 * Multi-tier configuration loader following modern Node.js standards:
 * Precedence:
 * 1. Explicit overrides (CLI flags)
 * 2. Environment variables (PR_AGENT_* / DEEPSEEK_*)
 * 3. Configuration file (pr-agent.config.ts, pr-agent.config.js, .pr-agentrc.json)
 * 4. Built-in defaults
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfigResult> {
  const cwd = options.cwd || process.cwd();

  const { config: fileConfig, configFile } = await c12LoadConfig<PRAgentUserConfig>({
    name: "pr-agent",
    configFile: options.configFile,
    cwd,
    rcFile: ".pr-agentrc",
    dotenv: true,
  });

  // Extract env overrides
  const envConfig: PRAgentUserConfig = {
    protocol: (process.env.PR_AGENT_PROTOCOL as PRAgentConfig["protocol"]) || undefined,
    apiKey:
      process.env.PR_AGENT_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY,
    baseURL:
      process.env.PR_AGENT_BASE_URL ||
      process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL,
    model: process.env.PR_AGENT_MODEL || process.env.DEEPSEEK_MODEL || undefined,
    budget: {
      maxCostUsd: process.env.PR_AGENT_MAX_COST_USD
        ? Number(process.env.PR_AGENT_MAX_COST_USD)
        : undefined,
    },
    telemetry: {
      enabled: process.env.PR_AGENT_TELEMETRY
        ? process.env.PR_AGENT_TELEMETRY !== "false"
        : undefined,
      phoenixEndpoint: process.env.PHOENIX_COLLECTOR_ENDPOINT,
    },
  };

  // Merge hierarchy: fileConfig -> envConfig -> CLI overrides
  const merged = deepMergeClean<Record<string, unknown>>(
    fileConfig as Record<string, unknown>,
    envConfig as Record<string, unknown>,
    options.overrides as Record<string, unknown>,
  );

  // Validate and apply schema defaults
  const parsed = PRAgentConfigSchema.parse(merged);

  return {
    config: parsed,
    configFile,
  };
}
