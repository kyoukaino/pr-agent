import { describe, it, expect } from "vite-plus/test";
import {
  MemoryCompressor,
  extractActions,
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

  it("lists calls in order with arguments only, marking recorded comments and failures", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "r1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/a.ts","start_line":10}' },
          },
          {
            id: "r2",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/gone.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "r1", content: "--- src/a.ts (L10-L400 of 900) ---\n10 | ..." },
      {
        role: "tool",
        tool_call_id: "r2",
        content: "Error executing tool 'read_file': file 'src/gone.ts' does not exist",
      },
      ...commentRound(
        "c1",
        { path: "a.ts", line: 3, severity: "P1", title: "Null deref", body: "long body" },
        "Comment recorded successfully on a.ts:3.",
      ),
      ...commentRound(
        "c2",
        { path: "b.ts", line: 9, severity: "P2", title: "Rejected", body: "long body" },
        "Error executing tool 'code_comment': 'b.ts' is not changed in this PR",
      ),
    ];
    expect(extractActions(msgs)).toEqual([
      '- read_file {"path":"src/a.ts","start_line":10}',
      `- read_file {"path":"src/gone.ts"} → Error executing tool 'read_file': file 'src/gone.ts' does not exist`,
      '- code_comment {"path":"a.ts","line":3,"severity":"P1","title":"Null deref"} → recorded',
      `- code_comment {"path":"b.ts","line":9,"severity":"P2","title":"Rejected"} → Error executing tool 'code_comment': 'b.ts' is not changed in this PR`,
    ]);
  });

  it("keeps the trajectory (comments included) after compression and reports the summary's usage", async () => {
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
    // Frozen messages are the very same objects: provider prompt caches keep hitting them.
    expect(out.messages[0]).toBe(msgs[0]);
    expect(out.messages[1]).toBe(msgs[1]);

    const memory = out.messages[2];
    expect(memory.role).toBe("user");
    expect(memory.memory?.summary).toBe("read a.ts; null deref confirmed");
    expect(memory.content).toContain(
      '<actions_taken>\n- code_comment {"path":"a.ts","line":3,"severity":"P1","title":"Null deref"} → recorded\n- read_file {}',
    );
    expect(memory.content).toContain('Comments marked "recorded" are already submitted');
    expect(memory.content).toContain("<previous_review_summary>\nread a.ts; null deref confirmed");
    expect(memory.content).not.toContain("result 0"); // tool output reaches the summarizer only
    expect(out.messages[3].role).toBe("assistant"); // active zone starts at a whole round
  });

  it("merges a later compression into the same memory slot", async () => {
    const prompts: string[] = [];
    let n = 0;
    const client = {
      chatCompletion: async (messages: ChatMessage[]) => {
        prompts.push(messages[1].content);
        return {
          content: `summary ${++n}`,
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
    const compressor = new MemoryCompressor(client);

    const first = await compressor.compress(conversation(6, 40_000), { maxContextTokens: 40_000 });
    const firstActions = first.messages[2].memory!.actions;

    // More rounds arrive after the first compression, then the context overflows again.
    const grown = [...first.messages, ...conversation(6, 40_000).slice(2)];
    const second = await compressor.compress(grown, { maxContextTokens: 40_000 });

    expect(second.messages[0]).toBe(grown[0]);
    expect(second.messages[1]).toBe(grown[1]);
    expect(second.messages.filter((m) => m.memory)).toHaveLength(1); // one slot, replaced
    const merged = second.messages[2].memory!;
    expect(merged.actions.slice(0, firstActions.length)).toEqual(firstActions); // trajectory kept verbatim
    expect(merged.actions.length).toBeGreaterThan(firstActions.length);
    expect(merged.summary).toBe("summary 2");
    expect(prompts[1]).toContain("<previous_summary>\nsummary 1\n</previous_summary>");
    expect(prompts[1]).not.toContain("Working memory"); // the old memory message is not re-serialized
  });
});
