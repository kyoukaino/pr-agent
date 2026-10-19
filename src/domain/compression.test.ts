import { describe, it, expect } from "vite-plus/test";
import {
  MemoryCompressor,
  extractSubmittedComments,
  partitionMessages,
  serializeTranscript,
} from "./compression.js";
import type { ChatMessage } from "../runtime/types.js";
import type { DeepSeekLLMClient } from "../llm/client.js";

function conversation(rounds: number, toolChars: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "review this diff" },
  ];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: "",
      // Large reasoning is kept for tracing but never sent to the API.
      reasoning_content: "thinking ".repeat(5_000),
      tool_calls: [
        { id: `t${i}`, type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    msgs.push({
      role: "tool",
      tool_call_id: `t${i}`,
      content: `result ${i} `.repeat(toolChars / 10),
    });
  }
  return msgs;
}

describe("partitionMessages", () => {
  it("compresses nothing when every round fits (regression: used to compress the whole history)", () => {
    const msgs = conversation(3, 100);
    const p = partitionMessages(msgs, 128_000);
    expect(p.compressEnd).toBe(p.frozenEnd);
  });

  it("keeps the most recent rounds verbatim when history is too large", () => {
    const msgs = conversation(6, 40_000); // ~8k tokens per round
    const p = partitionMessages(msgs, 40_000); // active budget 16k: room for ~1 round
    expect(p.compressEnd).toBeGreaterThan(p.frozenEnd);
    expect(p.compressEnd).toBeLessThan(msgs.length);
    expect(msgs[p.compressEnd].role).toBe("assistant"); // active zone starts at a whole round
  });
});

describe("MemoryCompressor", () => {
  it("returns the conversation untouched (no LLM call) when nothing needs compressing", async () => {
    let calls = 0;
    const client = {
      chatCompletion: async () => {
        calls++;
        return {
          content: "summary",
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheHitTokens: 0,
            costUsd: 0,
          },
        };
      },
    } as unknown as DeepSeekLLMClient;
    const msgs = conversation(3, 100);
    const out = await new MemoryCompressor(client).compress(msgs, { maxContextTokens: 128_000 });
    expect(out.messages).toBe(msgs);
    expect(out.usage).toBeUndefined();
    expect(calls).toBe(0);
  });
});

function commentRound(id: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "code_comment", arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

describe("trajectory preservation", () => {
  it("serializes tool calls with their arguments and names tool results", () => {
    const text = serializeTranscript(conversation(1, 10).slice(2));
    expect(text).toContain('<tool_call name="read_file">{}</tool_call>');
    expect(text).toContain('<tool_result name="read_file">');
    expect(text).not.toContain("thinking"); // reasoning is never replayed
  });

  it("lists only the code_comment calls that were accepted", () => {
    const msgs = [
      ...commentRound(
        "c1",
        { path: "a.ts", line: 3, severity: "P1", title: "Null deref" },
        "Comment recorded successfully on a.ts:3.",
      ),
      ...commentRound(
        "c2",
        { path: "b.ts", line: 9, severity: "P2", title: "Rejected" },
        "Error executing tool 'code_comment': 'b.ts' is not changed in this PR",
      ),
    ];
    expect(extractSubmittedComments(msgs)).toEqual(["- [P1] a.ts:3: Null deref"]);
  });

  it("keeps submitted comments verbatim after compression and reports the summary's usage", async () => {
    let prompt = "";
    const usage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheHitTokens: 0,
      costUsd: 0.001,
    };
    const client = {
      chatCompletion: async (messages: ChatMessage[]) => {
        prompt = messages[1].content;
        return { content: "read a.ts; null deref confirmed", usage };
      },
    } as unknown as DeepSeekLLMClient;

    const msgs = [
      ...conversation(0, 0),
      ...commentRound(
        "c1",
        { path: "a.ts", line: 3, severity: "P1", title: "Null deref" },
        "Comment recorded successfully on a.ts:3.",
      ),
      ...conversation(6, 40_000).slice(2),
    ];
    const out = await new MemoryCompressor(client).compress(msgs, { maxContextTokens: 40_000 });

    expect(prompt).toContain('<tool_call name="code_comment">');
    expect(out.usage).toEqual(usage);
    expect(out.messages.length).toBeLessThan(msgs.length);
    expect(out.messages[1].content).toContain("<comments_already_submitted>");
    expect(out.messages[1].content).toContain("- [P1] a.ts:3: Null deref");
    expect(out.messages[2].role).toBe("assistant"); // active zone starts at a whole round
  });
});
