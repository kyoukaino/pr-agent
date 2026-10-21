import { OpenAI } from "openai";
import type { ChatMessage, ToolCall } from "../../runtime/types.js";
import { AgentTelemetry } from "../../telemetry/otel.js";
import { withRetry } from "../../runtime/retry.js";
import { computeCostUsd, tryGetModelPricing, type TokenUsage } from "../pricing.js";
import type { ChatCompletionOptions, LLMResponse, ProtocolDriver, WireProtocol } from "../types.js";

export class OpenAIChatCompletionsDriver implements ProtocolDriver {
  public readonly protocol: WireProtocol = "openai-completions";

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
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
      maxRetries: 0,
    });

    const span = AgentTelemetry.startLLMSpan(config.model, messages[messages.length - 1]?.content);

    try {
      const response = await withRetry(
        async () => {
          return await client.chat.completions.create(
            {
              model: config.model,
              messages: messages.map((m) => {
                if (m.role === "tool") {
                  return {
                    role: "tool",
                    content: m.content,
                    tool_call_id: m.tool_call_id || "call_unknown",
                  };
                }
                if (m.role === "assistant") {
                  return {
                    role: "assistant",
                    content: m.content || "",
                    tool_calls: m.tool_calls as
                      | OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
                      | undefined,
                  };
                }
                return {
                  role: m.role,
                  content: m.content,
                };
              }),
              tools: tools && tools.length > 0 ? tools : undefined,
              temperature: config.temperature,
            },
            options.timeoutMs ? { signal, timeout: options.timeoutMs } : { signal },
          );
        },
        { maxRetries: 5, initialDelayMs: 2000, maxDelayMs: 30_000 },
        signal,
      );

      const choice = response.choices[0];
      const message = choice.message;
      const content = message.content || "";

      // Extract reasoning_content returned by thinking-mode models (DeepSeek, etc.)
      const reasoningContent = (message as unknown as { reasoning_content?: string })
        .reasoning_content;

      const toolCalls: ToolCall[] = (message.tool_calls || []).map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

      // Usage extraction with support for both DeepSeek and OpenAI cached tokens formats
      const raw = response.usage as
        | (OpenAI.Completions.CompletionUsage & {
            prompt_cache_hit_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          })
        | undefined;

      const cacheHitTokens =
        raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0;

      const tokens = {
        promptTokens: raw?.prompt_tokens || 0,
        completionTokens: raw?.completion_tokens || 0,
        totalTokens: raw?.total_tokens || 0,
        cacheHitTokens,
      };

      const pricing = tryGetModelPricing(config.model);
      const costUsd = pricing ? computeCostUsd(pricing, tokens) : 0;
      const usage: TokenUsage = { ...tokens, costUsd };

      AgentTelemetry.recordLLMResult(span, content, usage);
      span.end();

      return {
        content,
        reasoningContent,
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
