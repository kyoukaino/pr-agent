import { OpenAI } from "openai";
import type { ChatMessage, ToolCall } from "../runtime/types.js";
import { AgentTelemetry } from "../telemetry/otel.js";
import { withRetry } from "../runtime/retry.js";
import { computeCostUsd, getModelPricing, type ModelPricing, type TokenUsage } from "./pricing.js";

export interface LLMClientConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
}

export interface ChatCompletionOptions {
  /** Per-request timeout; a timed-out request is retried like other transient failures. */
  timeoutMs?: number;
}

export interface LLMResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
}

export class DeepSeekLLMClient {
  private client: OpenAI;
  public readonly model: string;
  public readonly temperature: number;
  private pricing: ModelPricing;

  constructor(config: LLMClientConfig = {}) {
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      // Retries are owned by withRetry below; stacking SDK retries on top multiplies attempts.
      maxRetries: 0,
    });
    this.model = config.model || process.env.DEEPSEEK_MODEL || "deepseek-flash";
    this.temperature = config.temperature ?? 0.1;
    this.pricing = getModelPricing(this.model);
  }

  public async chatCompletion(
    messages: ChatMessage[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    signal?: AbortSignal,
    options: ChatCompletionOptions = {},
  ): Promise<LLMResponse> {
    const span = AgentTelemetry.startLLMSpan(this.model, messages[messages.length - 1]?.content);

    try {
      const response = await withRetry(
        async () => {
          return await this.client.chat.completions.create(
            {
              model: this.model,
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
              temperature: this.temperature,
            },
            // The SDK rejects `timeout: undefined`, so only pass it when set.
            options.timeoutMs ? { signal, timeout: options.timeoutMs } : { signal },
          );
        },
        // Up to 5 retries with full-jitter backoff capped at 2s, 4s, 8s, 16s, 30s: rides out
        // short network outages (about a minute in total) before the group fails with llm_error.
        { maxRetries: 5, initialDelayMs: 2000, maxDelayMs: 30_000 },
        signal,
      );

      const choice = response.choices[0];
      const message = choice.message;
      const content = message.content || "";

      // Extract reasoning_content returned by thinking-mode models
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

      // DeepSeek reports the context-cache split as a non-standard usage field.
      const raw = response.usage as
        | (OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number })
        | undefined;
      const tokens = {
        promptTokens: raw?.prompt_tokens || 0,
        completionTokens: raw?.completion_tokens || 0,
        totalTokens: raw?.total_tokens || 0,
        cacheHitTokens: raw?.prompt_cache_hit_tokens || 0,
      };
      const usage: TokenUsage = { ...tokens, costUsd: computeCostUsd(this.pricing, tokens) };

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
