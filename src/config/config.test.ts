import { describe, it, expect } from "vite-plus/test";
import { BUDGET_DEFAULTS, defineConfig, PRAgentConfigSchema } from "./schema.js";
import { loadConfig } from "./loader.js";

describe("Configuration Subsystem", () => {
  it("should validate default configuration schema", () => {
    const config = PRAgentConfigSchema.parse({});
    // The reviewer model is a project convention; tunable values are only checked for being filled in.
    expect(config.model).toBe("deepseek-flash");
    expect(config.budget).toEqual(BUDGET_DEFAULTS);
    expect(config.temperature).toBeTypeOf("number");
    expect(config.review.minSeverityToBlock).toBeTypeOf("string");
  });

  it("should support latest deepseek-flash and deepseek-v4-pro models", () => {
    const flashConfig = PRAgentConfigSchema.parse({ model: "deepseek-flash" });
    expect(flashConfig.model).toBe("deepseek-flash");

    const v4ProConfig = PRAgentConfigSchema.parse({
      model: "deepseek-v4-pro",
      temperature: 0.2,
      budget: { maxCostUsd: 2.5 },
    });
    expect(v4ProConfig.model).toBe("deepseek-v4-pro");
    expect(v4ProConfig.temperature).toBe(0.2);
    expect(v4ProConfig.budget.maxCostUsd).toBe(2.5);
  });

  it("should preserve user configuration through defineConfig helper", () => {
    const userConfig = defineConfig({
      model: "deepseek-flash",
      rules: ["Never expose API keys"],
    });
    expect(userConfig.model).toBe("deepseek-flash");
    expect(userConfig.rules).toContain("Never expose API keys");
  });

  it("should resolve configuration via loadConfig with overrides", async () => {
    const { config } = await loadConfig({
      overrides: {
        model: "deepseek-v4-pro",
        budget: { maxCostUsd: 0.25 },
      },
    });

    expect(config.model).toBe("deepseek-v4-pro");
    expect(config.budget.maxCostUsd).toBe(0.25);
  });
});
