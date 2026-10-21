import type { OpenAI } from "openai";
import type { ChatMessage } from "../runtime/types.js";
import { OpenAIChatCompletionsDriver } from "./protocols/chat-completions.js";
import { AnthropicMessagesDriver } from "./protocols/anthropic-messages.js";
import { OpenAIResponsesDriver } from "./protocols/openai-responses.js";
import type {
  ChatCompletionOptions,
  LLMClient,
  LLMClientConfig,
  LLMResponse,
  ProtocolDriver,
  WireProtocol,
} from "./types.js";

export * from "./types.js";

function resolveDriver(protocol: WireProtocol): ProtocolDriver {
  switch (protocol) {
    case "openai-completions":
      return new OpenAIChatCompletionsDriver();
    case "anthropic-messages":
      return new AnthropicMessagesDriver();
    case "openai-responses":
      return new OpenAIResponsesDriver();
    default:
      throw new Error(`Unsupported wire protocol: '${protocol}'`);
  }
}

function resolveDefaultBaseURL(protocol: WireProtocol, apiKey?: string): string {
  if (protocol === "anthropic-messages") {
    if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
    // If the key is specifically an Anthropic key (starts with sk-ant), use official endpoint
    if (apiKey?.startsWith("sk-ant-") || process.env.ANTHROPIC_API_KEY) {
      return "https://api.anthropic.com";
    }
    // DeepSeek's Anthropic-compatible endpoint
    return "https://api.deepseek.com/anthropic";
  }

  if (protocol === "openai-responses") {
    if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;
    // If explicitly using DeepSeek environment without OpenAI key, target DeepSeek responses
    if (
      process.env.DEEPSEEK_API_KEY &&
      !process.env.OPENAI_API_KEY &&
      !apiKey?.startsWith("sk-proj-")
    ) {
      return "https://api.deepseek.com";
    }
    return "https://api.openai.com/v1";
  }

  if (process.env.DEEPSEEK_BASE_URL) return process.env.DEEPSEEK_BASE_URL;
  if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;
  if (
    apiKey?.startsWith("sk-proj-") ||
    (!process.env.DEEPSEEK_API_KEY && process.env.OPENAI_API_KEY)
  ) {
    return "https://api.openai.com/v1";
  }
  return "https://api.deepseek.com";
}

export class GenericLLMClient implements LLMClient {
  public readonly protocol: WireProtocol;
  public readonly model: string;
  public readonly temperature: number;
  private apiKey: string;
  private baseURL: string;
  private headers?: Record<string, string>;
  private driver: ProtocolDriver;

  constructor(config: LLMClientConfig = {}) {
    this.protocol = config.protocol || "openai-completions";
    this.model = config.model || process.env.DEEPSEEK_MODEL || "deepseek-flash";
    this.temperature = config.temperature ?? 0.1;
    this.headers = config.headers;

    const apiKey =
      config.apiKey ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error(
        "API key is not set (expected DEEPSEEK_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY)",
      );
    }
    this.apiKey = apiKey;
    this.baseURL = config.baseURL || resolveDefaultBaseURL(this.protocol, this.apiKey);
    this.driver = resolveDriver(this.protocol);
  }

  public async chatCompletion(
    messages: ChatMessage[],
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    signal?: AbortSignal,
    options: ChatCompletionOptions = {},
  ): Promise<LLMResponse> {
    return await this.driver.chat(
      {
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        model: this.model,
        temperature: this.temperature,
        headers: this.headers,
      },
      messages,
      tools,
      signal,
      options,
    );
  }
}

/**
 * Creates an LLM client configured with the given options and wire protocol.
 */
export function createLLMClient(config: LLMClientConfig = {}): LLMClient {
  return new GenericLLMClient(config);
}

/**
 * Backward-compatible DeepSeekLLMClient.
 * Defaults to the 'openai-completions' protocol targeting api.deepseek.com.
 */
export class DeepSeekLLMClient extends GenericLLMClient {
  constructor(config: LLMClientConfig = {}) {
    super({
      ...config,
      protocol: config.protocol ?? "openai-completions",
    });
  }
}
