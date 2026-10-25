import { describe, it, expect } from "vite-plus/test";
import {
  ContextMeter,
  ExecutionBudgetController,
  estimateMessagesTokens,
  estimateTokens,
} from "./budget.js";
import type { ChatMessage } from "./types.js";

const spend = (costUsd: number) => ({ promptTokens: 1000, completionTokens: 100, costUsd });

describe("ExecutionBudgetController", () => {
  it("estimates tokens from characters at DeepSeek's measured ratio", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(235))).toBe(100);
    expect(estimateTokens("x".repeat(236))).toBe(101);
  });

  it("counts content and tool calls but not reasoning", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(235) },
      {
        role: "assistant",
        content: "",
        reasoning_content: "y".repeat(10_000),
        tool_calls: [
          { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBe(100 + 4 + 1);
  });

  it("uses the context window only for the compression watermark", () => {
    const budget = new ExecutionBudgetController({ maxContextTokens: 1000, maxCostUsd: 1 });
    expect(budget.promptTokenLimit).toBe(800); // 80%
    expect(budget.softTokenLimit).toBe(600); // 60%
    budget.recordUsage({ promptTokens: 50_000, completionTokens: 5_000, costUsd: 0.01 });
    expect(budget.isCostBudgetExceeded()).toBe(false); // tokens alone never stop a review
  });

  it("compares the measured context against the warning watermark", () => {
    const budget = new ExecutionBudgetController({ maxContextTokens: 1000 });
    expect(budget.shouldCompress(800)).toBe(false);
    expect(budget.shouldCompress(801)).toBe(true);
    expect(budget.shouldTriggerAsyncCompression(700)).toBe(true);
    expect(budget.shouldTriggerAsyncCompression(900)).toBe(false);
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

describe("ContextMeter", () => {
  const msg = (chars: number): ChatMessage => ({ role: "user", content: "x".repeat(chars) });

  it("estimates the whole request, tool definitions included, before any billed count", () => {
    const meter = new ContextMeter(50);
    expect(meter.anchored).toBe(false);
    expect(meter.measure([msg(235), msg(235)])).toBe(250);
  });

  it("anchors on the last billed prompt and estimates only what was appended since", () => {
    const meter = new ContextMeter(50);
    const messages = [msg(235), msg(235)];
    meter.record(messages.length, 5_000);
    expect(meter.measure(messages)).toBe(5_000);
    messages.push(msg(470));
    expect(meter.measure(messages)).toBe(5_200);
  });

  it("falls back to a full estimate once invalidated or when the history shrank", () => {
    const meter = new ContextMeter(50);
    meter.record(3, 5_000);
    expect(meter.measure([msg(235)])).toBe(150); // fewer messages than the anchor counted
    meter.invalidate();
    expect(meter.measure([msg(235), msg(235), msg(235)])).toBe(350);
    meter.record(1, 0); // a zero count is not trusted
    expect(meter.anchored).toBe(false);
  });
});
