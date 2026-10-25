// Type-only import: erased at load time, so this file also works in the runtime image without src/.
import type { PRAgentUserConfig } from "./src/index.ts";

export default {
  // "deepseek-flash": high throughput, lowest latency & cost (daily CI checks)
  // "deepseek-v4-pro": flagship reasoning & long context (security / architecture audits)
  model: "deepseek-flash",

  // Low temperature keeps bug finding deterministic
  temperature: 0.1,

  budget: {
    // Spending cap per PR review in USD, computed from DeepSeek pricing and cache hits
    maxCostUsd: 1,
    // Context window used for memory compression (not a spending limit)
    maxContextTokens: 256_000,
    roundTimeoutMs: 300_000, // per LLM call; reasoning models can think for minutes
    totalTimeoutMs: 1_800_000,
  },

  // Safety backstop against runaway loops; spending is bounded by maxCostUsd
  limits: {
    maxRounds: 100,
  },

  review: {
    minSeverityToBlock: "P1", // P0 and P1 trigger REQUEST_CHANGES
    maxCommentsPerReview: 30,
    enableAstGrep: true,
  },

  // Repository-specific guidelines injected into the agent system prompt
  rules: [
    "Verify JWT and authentication secrets are not hardcoded or leaked in logs",
    "Ensure all async database and external network calls have timeout handling",
    "Prevent race conditions in concurrent state mutations",
    "Flag any potential SQL/NoSQL injection or prototype pollution vulnerabilities",
  ],

  // OpenTelemetry / Arize Phoenix tracing
  telemetry: {
    enabled: true,
    serviceName: "pr-agent-service",
    phoenixEndpoint: "http://localhost:6006/v1/traces",
  },
} satisfies PRAgentUserConfig;
