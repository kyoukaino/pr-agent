import { describe, it, expect } from "vite-plus/test";
import { toResponsesPayload, toResponsesTools } from "./openai-responses.js";
import type { ChatMessage } from "../../runtime/types.js";
import type { OpenAI } from "openai";

describe("OpenAI Responses protocol payload mapping", () => {
  it("converts OpenAI chat tools to Responses tools", () => {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from repo",
          parameters: {
            type: "object",
            required: ["path"],
            properties: {
              path: { type: "string" },
            },
          },
        },
      },
    ];

    const respTools = toResponsesTools(tools);
    expect(respTools).toBeDefined();
    expect(respTools).toHaveLength(1);
    expect(respTools![0]).toEqual({
      type: "function",
      name: "read_file",
      description: "Read a file from repo",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      strict: false,
    });
  });

  it("converts canonical ChatMessage[] into instructions and response input items", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a code reviewer." },
      { role: "user", content: "Check this change" },
      {
        role: "assistant",
        content: "I will read the file",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"index.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "export const x = 1;" },
    ];

    const { instructions, input } = toResponsesPayload(messages);

    expect(instructions).toBe("You are a code reviewer.");
    expect(input).toHaveLength(4);

    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: "Check this change",
    });

    expect(input[1]).toEqual({
      type: "message",
      role: "assistant",
      content: "I will read the file",
    });

    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_abc",
      name: "read_file",
      arguments: '{"path":"index.ts"}',
    });

    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: "export const x = 1;",
    });
  });
});
