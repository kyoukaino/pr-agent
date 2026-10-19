import { context, trace, type Tracer, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  SemanticConventions,
  LLM_MODEL_NAME,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_TOTAL,
  INPUT_VALUE,
  OUTPUT_VALUE,
} from "@arizeai/openinference-semantic-conventions";
import type { TokenUsage } from "../llm/pricing.js";

export interface TelemetryConfig {
  enabled: boolean;
  serviceName?: string;
  phoenixEndpoint?: string; // Default: "http://localhost:6006/v1/traces"
}

// Enable Node AsyncLocalStorage context propagation across async/await calls
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

let tracerProvider: BasicTracerProvider | null = null;
let prAgentTracer: Tracer | null = null;

/**
 * Registers the global tracer provider once per process. Long-running callers (the webhook worker,
 * the bench) call this per review; re-registering would stack providers and exporters.
 */
export function initTelemetry(config: TelemetryConfig): Tracer {
  if (!config.enabled) {
    return trace.getTracer("pr-agent-noop");
  }
  if (prAgentTracer && tracerProvider) {
    return prAgentTracer;
  }

  const endpoint =
    config.phoenixEndpoint ||
    process.env.PHOENIX_COLLECTOR_ENDPOINT ||
    "http://localhost:6006/v1/traces";

  const exporter = new OTLPTraceExporter({
    url: endpoint,
  });

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName || "pr-agent",
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  tracerProvider = new BasicTracerProvider({ resource });
  // Batch export keeps span export off the hot path (one HTTP request per span otherwise).
  tracerProvider.addSpanProcessor(new BatchSpanProcessor(exporter));
  tracerProvider.register();

  prAgentTracer = tracerProvider.getTracer("pr-agent", "0.1.0");
  return prAgentTracer;
}

export function getTracer(): Tracer {
  if (!prAgentTracer) {
    prAgentTracer = trace.getTracer("pr-agent", "0.1.0");
  }
  return prAgentTracer;
}

export class AgentTelemetry {
  /**
   * Executes an asynchronous operation inside the context of an active span.
   * Child spans created within this async scope will automatically inherit this span as their parent.
   */
  public static async withSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    return context.with(trace.setSpan(context.active(), span), fn);
  }

  /**
   * Starts an OpenInference compliant AGENT / CHAIN span.
   */
  public static startAgentSpan(name: string, input?: string): Span {
    const tracer = getTracer();
    const span = tracer.startSpan(name);
    span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, "AGENT");
    if (input) {
      span.setAttribute(INPUT_VALUE, input);
    }
    return span;
  }

  /**
   * Starts an OpenInference compliant LLM span.
   */
  public static startLLMSpan(model: string, promptPreview?: string): Span {
    const tracer = getTracer();
    const span = tracer.startSpan(`llm.completion.${model}`);
    span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, "LLM");
    span.setAttribute(LLM_MODEL_NAME, model);
    span.setAttribute("llm.provider", "deepseek");
    if (promptPreview) {
      span.setAttribute(INPUT_VALUE, promptPreview.slice(0, 4000));
    }
    return span;
  }

  /**
   * Records LLM output and token usage.
   */
  public static recordLLMResult(span: Span, responsePreview: string, usage?: TokenUsage): void {
    span.setAttribute(OUTPUT_VALUE, responsePreview.slice(0, 4000));
    if (usage) {
      span.setAttribute(LLM_TOKEN_COUNT_PROMPT, usage.promptTokens);
      span.setAttribute(LLM_TOKEN_COUNT_COMPLETION, usage.completionTokens);
      span.setAttribute(LLM_TOKEN_COUNT_TOTAL, usage.totalTokens);
      span.setAttribute("llm.token_count.prompt_details.cache_read", usage.cacheHitTokens);
      span.setAttribute("llm.cost.total", usage.costUsd);
    }
  }

  /**
   * Starts an OpenInference compliant TOOL span.
   */
  public static startToolSpan(toolName: string, parametersJson: string): Span {
    const tracer = getTracer();
    const span = tracer.startSpan(`tool.${toolName}`);
    span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, "TOOL");
    span.setAttribute("tool.name", toolName);
    span.setAttribute(INPUT_VALUE, parametersJson);
    return span;
  }

  /**
   * Records tool execution outcome.
   */
  public static recordToolResult(span: Span, resultText: string, error?: Error): void {
    if (error) {
      span.recordException(error);
      span.setAttribute("error", true);
      span.setAttribute(OUTPUT_VALUE, error.message);
    } else {
      span.setAttribute(OUTPUT_VALUE, resultText.slice(0, 4000));
    }
  }
}

export async function flushTelemetry(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.forceFlush();
  }
}
