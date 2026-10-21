import type { OpenAI } from "openai";
import type { ChatMessage, ToolCall } from "../runtime/types.js";
import type { TokenUsage } from "./pricing.js";

export type WireProtocol = "openai-completions" | "anthropic-messages" | "openai-responses";

export interface LLMClientConfig {
  protocol?: WireProtocol;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
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

export interface ProtocolDriver {
  readonly protocol: WireProtocol;
  chat(
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
    options?: ChatCompletionOptions,
  ): Promise<LLMResponse>;
}

export interface LLMClient {
  readonly model: string;
  readonly temperature: number;
  readonly protocol: WireProtocol;
  chatCompletion(
    messages: ChatMessage[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    signal?: AbortSignal,
    options?: ChatCompletionOptions,
  ): Promise<LLMResponse>;
}
