import { OpenAI } from "openai";
import type { ChatMessage, ToolCall } from "../../runtime/types.js";
import { AgentTelemetry } from "../../telemetry/otel.js";
import { withRetry } from "../../runtime/retry.js";
import { computeCostUsd, tryGetModelPricing, type TokenUsage } from "../pricing.js";
import type { ChatCompletionOptions, LLMResponse, ProtocolDriver, WireProtocol } from "../types.js";

/** Transforms standard OpenAI tools into Responses API tools format */
export function toResponsesTools(
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): OpenAI.Responses.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description ?? null,
    parameters: (t.function.parameters as Record<string, unknown>) ?? null,
    strict: false,
  }));
}

/**
 * Transforms internal canonical ChatMessage[] into Responses API input items + instructions.
 */
export function toResponsesPayload(messages: ChatMessage[]): {
  instructions?: string;
  input: OpenAI.Responses.ResponseInputItem[];
} {
  const instructionsParts: string[] = [];
  const input: OpenAI.Responses.ResponseInputItem[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) instructionsParts.push(m.content);
      continue;
    }

    if (m.role === "assistant") {
      if (m.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: m.content,
        });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      continue;
    }

    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "call_unknown",
        output: m.content,
      });
      continue;
    }

    // role === "user"
    input.push({
      type: "message",
      role: "user",
      content: m.content,
    });
  }

  return {
    instructions: instructionsParts.length > 0 ? instructionsParts.join("\n\n") : undefined,
    input,
  };
}

export class OpenAIResponsesDriver implements ProtocolDriver {
  public readonly protocol: WireProtocol = "openai-responses";

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
      const { instructions, input } = toResponsesPayload(messages);
      const responsesTools = toResponsesTools(tools);

      const response = await withRetry(
        async () => {
          return await client.responses.create(
            {
              model: config.model,
              instructions,
              input,
              tools: responsesTools,
              temperature: config.temperature,
            },
            options.timeoutMs ? { signal, timeout: options.timeoutMs } : { signal },
          );
        },
        { maxRetries: 5, initialDelayMs: 2000, maxDelayMs: 30_000 },
        signal,
      );

      const content = response.output_text || "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];

      for (const item of response.output || []) {
        if (item.type === "function_call") {
          toolCalls.push({
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments,
            },
          });
        } else if (item.type === "reasoning") {
          // Extract reasoning item text or summary
          const reasoningItem = item as unknown as { summary?: string[]; text?: string };
          if (reasoningItem.text) {
            reasoningContent += reasoningItem.text;
          } else if (reasoningItem.summary) {
            reasoningContent += reasoningItem.summary.join("\n");
          }
        }
      }

      const rawUsage = response.usage as unknown as {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_token_details?: { cached_tokens?: number };
      };

      const cacheHitTokens = rawUsage?.input_token_details?.cached_tokens || 0;
      const promptTokens = rawUsage?.input_tokens || 0;
      const completionTokens = rawUsage?.output_tokens || 0;
      const totalTokens = rawUsage?.total_tokens || promptTokens + completionTokens;

      const tokens = {
        promptTokens,
        completionTokens,
        totalTokens,
        cacheHitTokens,
      };

      const pricing = tryGetModelPricing(config.model);
      const costUsd = pricing ? computeCostUsd(pricing, tokens) : 0;
      const usage: TokenUsage = { ...tokens, costUsd };

      AgentTelemetry.recordLLMResult(span, content, usage);
      span.end();

      return {
        content,
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
