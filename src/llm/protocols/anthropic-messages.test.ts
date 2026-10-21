import { describe, it, expect } from "vite-plus/test";
import { toAnthropicPayload, toAnthropicTools } from "./anthropic-messages.js";
import type { ChatMessage } from "../../runtime/types.js";
import type { OpenAI } from "openai";

describe("Anthropic protocol payload mapping", () => {
  it("converts OpenAI tools to Anthropic tools", () => {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "code_comment",
          description: "Submits a review comment",
          parameters: {
            type: "object",
            required: ["path", "line", "body"],
            properties: {
              path: { type: "string" },
              line: { type: "integer" },
              body: { type: "string" },
            },
          },
        },
      },
    ];

    const anthropicTools = toAnthropicTools(tools);
    expect(anthropicTools).toBeDefined();
    expect(anthropicTools).toHaveLength(1);
    expect(anthropicTools![0]).toEqual({
      name: "code_comment",
      description: "Submits a review comment",
      input_schema: {
        type: "object",
        required: ["path", "line", "body"],
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          body: { type: "string" },
        },
      },
    });
  });

  it("extracts system message and injects ephemeral cache breakpoint at first user message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a code review assistant." },
      { role: "user", content: "diff --git a/file.ts b/file.ts\n+const x = 1;" },
      { role: "assistant", content: "I will check the diff." },
      { role: "user", content: "Next step" },
    ];

    const { system, messages: anthropicMessages } = toAnthropicPayload(messages, true);

    expect(system).toBe("You are a code review assistant.");
    expect(anthropicMessages).toHaveLength(3);

    // First user message should have cache_control breakpoint
    expect(anthropicMessages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "diff --git a/file.ts b/file.ts\n+const x = 1;",
          cache_control: { type: "ephemeral" },
        },
      ],
    });

    // Assistant message
    expect(anthropicMessages[1]).toEqual({
      role: "assistant",
      content: "I will check the diff.",
    });

    // Latest user message should have sliding cache_control breakpoint
    expect(anthropicMessages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Next step",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("slides the dynamic breakpoint to the latest turn while keeping anchor breakpoint on frozen diff", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "frozen diff content" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result round 1" },
      {
        role: "assistant",
        content: "checking 2",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "grep_code", arguments: '{"pattern":"foo"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: "result round 2" },
    ];

    const { messages: anthropicMessages } = toAnthropicPayload(messages, true);

    // [0]: User (frozen diff) -> Breakpoint 1 (Anchor)
    // [1]: Assistant (round 1)
    // [2]: User (round 1 tool result) -> NO breakpoint (slid forward)
    // [3]: Assistant (round 2)
    // [4]: User (round 2 tool result) -> Breakpoint 2 (Sliding)
    expect(anthropicMessages).toHaveLength(5);

    // Breakpoint 1: Anchor on frozen diff
    const diffBlock = (anthropicMessages[0].content as any[])[0];
    expect(diffBlock.cache_control).toEqual({ type: "ephemeral" });

    // Round 1 tool result: sliding breakpoint has moved past it
    const round1Block = (anthropicMessages[2].content as any[])[0];
    expect(round1Block.cache_control).toBeUndefined();

    // Round 2 tool result: has the active sliding breakpoint
    const round2Block = (anthropicMessages[4].content as any[])[0];
    expect(round2Block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("merges consecutive tool results into a single user message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "calling tools",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "foo.ts" }) },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "grep_code", arguments: JSON.stringify({ pattern: "bar" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "content of foo.ts" },
      { role: "tool", tool_call_id: "call_2", content: "matches for bar" },
    ];

    const { messages: anthropicMessages } = toAnthropicPayload(messages, false);

    // [0]: user (start)
    // [1]: assistant (with tool_use blocks)
    // [2]: user (with BOTH tool_result blocks merged)
    expect(anthropicMessages).toHaveLength(3);

    const assistantMsg = anthropicMessages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toEqual([
      { type: "text", text: "calling tools" },
      {
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { path: "foo.ts" },
      },
      {
        type: "tool_use",
        id: "call_2",
        name: "grep_code",
        input: { pattern: "bar" },
      },
    ]);

    const toolResultMsg = anthropicMessages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "content of foo.ts",
      },
      {
        type: "tool_result",
        tool_use_id: "call_2",
        content: "matches for bar",
      },
    ]);
  });

  it("merges consecutive user messages to enforce alternating roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "diff chunk 1" },
      { role: "user", content: "compressed memory slot" },
      { role: "assistant", content: "acknowledged" },
    ];

    const { messages: anthropicMessages } = toAnthropicPayload(messages, true);

    // Consecutive users should be merged into 1 user message with 2 blocks
    expect(anthropicMessages).toHaveLength(2);
    expect(anthropicMessages[0].role).toBe("user");
    expect(anthropicMessages[0].content).toEqual([
      {
        type: "text",
        text: "diff chunk 1",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "compressed memory slot",
      },
    ]);
    expect(anthropicMessages[1].role).toBe("assistant");
  });
});
