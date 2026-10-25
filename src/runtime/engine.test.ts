import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { AgentRuntimeEngine } from "./engine.js";
import { MainLoopStop, type ChatMessage } from "./types.js";
import { RunTraceRecorder } from "./trace.js";
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

describe("AgentRuntimeEngine compression trigger", () => {
  it("compresses when the billed prompt plus new rounds crosses the watermark, and traces it", async () => {
    const billed = [1_000, 15_000, 1_000, 1_000];
    let n = 0;
    const client = {
      chatCompletion: async (_messages: ChatMessage[], tools?: unknown): Promise<LLMResponse> => {
        const usage = (promptTokens: number) => ({
          promptTokens,
          completionTokens: 10,
          totalTokens: promptTokens + 10,
          cacheHitTokens: 0,
          costUsd: 0.001,
        });
        if (!tools) return { content: "summary of earlier rounds", usage: usage(500) };
        n++;
        return {
          content: "x".repeat(10_000), // ~4.3k estimated tokens per round
          toolCalls: [
            {
              id: `call_${n}`,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
            },
          ],
          usage: usage(billed[n - 1] ?? 1_000),
        };
      },
    } as unknown as DeepSeekLLMClient;
    const traceRecorder = new RunTraceRecorder(
      "t",
      "repo",
      "sha",
      "model",
      fs.mkdtempSync(path.join(os.tmpdir(), "trace-")),
    );
    const engine = new AgentRuntimeEngine({
      runId: "test",
      repoDir: os.tmpdir(),
      llmClient: client,
      budgetConfig: { maxContextTokens: 20_000 },
      traceRecorder,
      maxRounds: 3,
    });

    const result = await engine.executeSubtask("g1", task("g1"));

    // Estimates alone (~8.6k after two rounds) stay under 16k; the billed 15k of call 2 does not.
    const [compression] = traceRecorder.manifestSnapshot.compressions;
    expect(traceRecorder.manifestSnapshot.compressions).toHaveLength(1);
    expect(compression).toMatchObject({
      subtaskKey: "g1",
      measuredFrom: "billed",
      compressed: true,
      messagesBefore: 6,
      messagesAfter: 5,
    });
    expect(compression.tokensBefore).toBeGreaterThan(16_000);
    expect(compression.tokensAfter).toBeLessThan(16_000);
    expect(compression.usage?.promptTokens).toBe(500);
    expect(result.messages[2].memory?.summary).toBe("summary of earlier rounds");
    expect(result.stopReason).toBe(MainLoopStop.StopMaxRounds);
  });
});
