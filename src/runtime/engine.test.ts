import * as os from "node:os";
import { describe, it, expect } from "vite-plus/test";
import { AgentRuntimeEngine } from "./engine.js";
import { MainLoopStop, type ChatMessage } from "./types.js";
import type { DeepSeekLLMClient, LLMResponse } from "../llm/client.js";

/** Scripted model: always explores (read_file), each call costing `costPerCall` USD. */
function exploringClient(costPerCall: number, log: string[]) {
  let n = 0;
  return {
    chatCompletion: async (messages: ChatMessage[]): Promise<LLMResponse> => {
      log.push(messages[1].content);
      n++;
      return {
        content: "",
        toolCalls: [
          {
            id: `call_${n}`,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
          },
        ],
        usage: {
          promptTokens: 1000,
          completionTokens: 100,
          totalTokens: 1100,
          cacheHitTokens: 0,
          costUsd: costPerCall,
        },
      };
    },
  } as unknown as DeepSeekLLMClient;
}

const task = (group: string): ChatMessage[] => [
  { role: "system", content: "system" },
  { role: "user", content: group },
];

describe("AgentRuntimeEngine cost budget", () => {
  it("stops a group at its fair share and still lets later groups explore", async () => {
    const calls: string[] = [];
    const engine = new AgentRuntimeEngine({
      runId: "test",
      repoDir: os.tmpdir(),
      llmClient: exploringClient(0.3, calls),
      budgetConfig: { maxCostUsd: 1 },
      maxRounds: 10,
    });

    const first = await engine.executeSubtask("g1", task("g1"), 2); // share 0.5
    expect(first.stopReason).toBe(MainLoopStop.StopCostBudget);
    // two exploring rounds (0.3, 0.6 >= 0.5) plus the grace round
    expect(calls.filter((c) => c === "g1")).toHaveLength(3);

    const second = await engine.executeSubtask("g2", task("g2"), 1); // everything left
    expect(second.stopReason).toBe(MainLoopStop.StopCostBudget);
    expect(calls.filter((c) => c === "g2").length).toBeGreaterThanOrEqual(2); // explored, then grace
    expect(first.costUsd + second.costUsd).toBeCloseTo(engine.costUsd);
  });
});
