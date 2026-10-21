import { Anthropic } from "@anthropic-ai/sdk";
import type { OpenAI } from "openai";
import type { ChatMessage, ToolCall } from "../../runtime/types.js";
import { AgentTelemetry } from "../../telemetry/otel.js";
import { withRetry } from "../../runtime/retry.js";
import { computeCostUsd, tryGetModelPricing, type TokenUsage } from "../pricing.js";
import type { ChatCompletionOptions, LLMResponse, ProtocolDriver, WireProtocol } from "../types.js";

/** Converts standard OpenAI-style tool definitions to Anthropic's tool format */
export function toAnthropicTools(
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters as Anthropic.Tool.InputSchema) || {
      type: "object",
      properties: {},
    },
  }));
}

/**
 * Transforms internal canonical ChatMessage[] into Anthropic system + messages payload.
 * - Extracts system messages into a top-level system parameter.
 * - Converts tool results into user message blocks with type: 'tool_result'.
 * - Merges consecutive tool results into a single user message (required by Anthropic API).
 * - Injects cache_control: { type: 'ephemeral' } at the first user message (PR Diff / Frozen boundary).
 */
export function toAnthropicPayload(
  messages: ChatMessage[],
  injectCacheBreakpoint = true,
): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const anthropicMessages: Anthropic.MessageParam[] = [];
  let userMessageCount = 0;

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }

    if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const contentBlocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          contentBlocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.tool_calls) {
          let inputObj: Record<string, unknown> = {};
          try {
            inputObj = JSON.parse(tc.function.arguments);
          } catch {
            inputObj = { raw: tc.function.arguments };
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: inputObj,
          });
        }
        anthropicMessages.push({
          role: "assistant",
          content: contentBlocks,
        });
      } else {
        anthropicMessages.push({
          role: "assistant",
          content: m.content || " ",
        });
      }
      continue;
    }

    if (m.role === "tool") {
      const toolBlock: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.tool_call_id || "call_unknown",
        content: m.content,
      };

      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Merge consecutive tool results into the same user message
        (last.content as Anthropic.ContentBlockParam[]).push(toolBlock);
      } else {
        anthropicMessages.push({
          role: "user",
          content: [toolBlock],
        });
      }
      continue;
    }

    // Normal user message
    userMessageCount++;
    const prev = anthropicMessages[anthropicMessages.length - 1];
    if (prev && prev.role === "user") {
      // Merge consecutive user messages (e.g. diff + compressed memory) to enforce strict alternating roles
      if (typeof prev.content === "string") {
        prev.content = [{ type: "text", text: prev.content }];
      }
      (prev.content as Anthropic.ContentBlockParam[]).push({
        type: "text",
        text: m.content,
      });
    } else if (injectCacheBreakpoint && userMessageCount === 1) {
      // First user message is the task/diff message (Frozen zone boundary).
      // Mark it with cache_control: { type: "ephemeral" } for prompt caching.
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: m.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      });
    } else {
      anthropicMessages.push({
        role: "user",
        content: m.content,
      });
    }
  }

  // Dual-breakpoint strategy:
  // - Breakpoint 1: Static anchor on initial task/diff (Frozen zone) set above.
  // - Breakpoint 2: Automatic sliding breakpoint on the latest user interaction (tool results / follow-up).
  if (injectCacheBreakpoint && anthropicMessages.length > 1) {
    for (let i = anthropicMessages.length - 1; i >= 0; i--) {
      const msg = anthropicMessages[i];
      if (msg.role === "user") {
        if (i > 0) {
          if (typeof msg.content === "string") {
            msg.content = [
              {
                type: "text",
                text: msg.content,
                cache_control: { type: "ephemeral" },
              },
            ];
          } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            const lastBlock = msg.content[msg.content.length - 1] as {
              cache_control?: { type: "ephemeral" };
            };
            lastBlock.cache_control = { type: "ephemeral" };
          }
        }
        break;
      }
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

export class AnthropicMessagesDriver implements ProtocolDriver {
  public readonly protocol: WireProtocol = "anthropic-messages";

  public async chat(
    config: {
      apiKey: string;
      baseURL: string;
      model: string;
      temperature: number;
      headers?: Record<string, string>;
    },
    messages: ChatMessage[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    signal?: AbortSignal,
    options: ChatCompletionOptions = {},
  ): Promise<LLMResponse> {
    const client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
      maxRetries: 0,
    });

    const span = AgentTelemetry.startLLMSpan(config.model, messages[messages.length - 1]?.content);

    try {
      const { system, messages: anthropicMessages } = toAnthropicPayload(messages, true);
      const anthropicTools = toAnthropicTools(tools);

      const response = await withRetry(
        async () => {
          return await client.messages.create(
            {
              model: config.model,
              max_tokens: 8192,
              system,
              messages: anthropicMessages,
              tools: anthropicTools,
              temperature: config.temperature,
            },
            options.timeoutMs ? { signal, timeout: options.timeoutMs } : { signal },
          );
        },
        { maxRetries: 5, initialDelayMs: 2000, maxDelayMs: 30_000 },
        signal,
      );

      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if ((block as { type: string; thinking?: string }).type === "thinking") {
          reasoningContent += (block as { thinking?: string }).thinking || "";
        }
      }

      // Usage extraction including cache read tokens
      const rawUsage = response.usage as unknown as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      const cacheHitTokens = rawUsage?.cache_read_input_tokens || 0;
      const cacheWriteTokens = rawUsage?.cache_creation_input_tokens || 0;
      const promptTokens = (rawUsage?.input_tokens || 0) + cacheHitTokens + cacheWriteTokens;
      const completionTokens = rawUsage?.output_tokens || 0;
      const totalTokens = promptTokens + completionTokens;

      const tokens = {
        promptTokens,
        completionTokens,
        totalTokens,
        cacheHitTokens,
      };

      const pricing = tryGetModelPricing(config.model);
      const costUsd = pricing ? computeCostUsd(pricing, tokens) : 0;
      const usage: TokenUsage = { ...tokens, costUsd };

      AgentTelemetry.recordLLMResult(span, textContent, usage);
      span.end();

      return {
        content: textContent,
        reasoningContent: reasoningContent || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setAttribute("error", true);
      span.end();
      throw err;
    }
  }
}
