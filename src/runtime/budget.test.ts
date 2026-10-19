import { describe, it, expect } from "vite-plus/test";
import { ExecutionBudgetController, countTokens, countMessagesTokens } from "./budget.js";
import type { ChatMessage } from "./types.js";

const spend = (costUsd: number) => ({ promptTokens: 1000, completionTokens: 100, costUsd });

describe("ExecutionBudgetController", () => {
  it("should count tokens correctly", () => {
    expect(countTokens("Hello world from PR-Agent!")).toBeGreaterThan(0);
  });

  it("should calculate message tokens", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a reviewer." },
      { role: "user", content: "Please review my code." },
    ];
    expect(countMessagesTokens(messages)).toBeGreaterThan(5);
  });

  it("uses the context window only for the compression watermark", () => {
    const budget = new ExecutionBudgetController({ maxContextTokens: 1000, maxCostUsd: 1 });
    expect(budget.promptTokenLimit).toBe(800); // 80%
    expect(budget.softTokenLimit).toBe(600); // 60%
    budget.recordUsage({ promptTokens: 50_000, completionTokens: 5_000, costUsd: 0.01 });
    expect(budget.isCostBudgetExceeded()).toBe(false); // tokens alone never stop a review
  });

  it("gives each subtask a fair share of the remaining cost, rolling unused budget forward", () => {
    const budget = new ExecutionBudgetController({ maxCostUsd: 1 });

    budget.beginSubtask(4); // share: 0.25
    budget.recordUsage(spend(0.2));
    expect(budget.isCostBudgetExceeded()).toBe(false);
    budget.recordUsage(spend(0.06));
    expect(budget.isCostBudgetExceeded()).toBe(true);

    budget.beginSubtask(3); // remaining 0.74 / 3
    budget.recordUsage(spend(0.24));
    expect(budget.isCostBudgetExceeded()).toBe(false); // an earlier overrun does not starve this group

    budget.beginSubtask(1); // the last group gets everything that is left
    budget.recordUsage(spend(0.4));
    expect(budget.isCostBudgetExceeded()).toBe(false);
    budget.recordUsage(spend(0.11));
    expect(budget.costUsd).toBeCloseTo(1.01);
    expect(budget.isCostBudgetExceeded()).toBe(true);
  });

  it("treats maxCostUsd 0 as unlimited", () => {
    const budget = new ExecutionBudgetController({ maxCostUsd: 0 });
    budget.beginSubtask(2);
    budget.recordUsage(spend(100));
    expect(budget.isCostBudgetExceeded()).toBe(false);
  });

  it("splits the remaining wall-clock time across subtasks", () => {
    const budget = new ExecutionBudgetController({ totalTimeoutMs: 60_000 });
    const start = Date.now();
    budget.beginSubtask(3, start); // deadline: start + 20s
    expect(budget.isTimedOut(start + 19_000)).toBe(false);
    expect(budget.isTimedOut(start + 21_000)).toBe(true);

    budget.beginSubtask(2, start + 30_000); // remaining 30s / 2 = 15s
    expect(budget.isTimedOut(start + 44_000)).toBe(false);
    expect(budget.isTimedOut(start + 46_000)).toBe(true);
  });
});
