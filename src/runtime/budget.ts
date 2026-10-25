import type { ChatMessage } from "./types.js";

/**
 * Characters per billed token, measured on DeepSeek over 2135 review rounds of code-heavy context
 * (cl100k is ~4, so a tokenizer like tiktoken undercounts by ~1.7x; it was no more precise per round).
 */
export const CHARS_PER_TOKEN = 2.35;

/** Character-based token estimate, used where no billed count is available. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    // reasoning_content is kept for tracing but never sent back to the API, so it is not counted.
    total += estimateTokens(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Size of the next request, anchored on what the API billed for the previous one: its
 * `prompt_tokens` plus an estimate of the messages appended since. Only the appended part is
 * estimated, so the estimate error stays small. Without an anchor (first call, a resumed session,
 * right after compression rewrote the history) the whole request is estimated, tool definitions
 * included via `fixedTokens`.
 */
export class ContextMeter {
  private anchor: { tokens: number; messageCount: number } | null = null;

  constructor(private readonly fixedTokens = 0) {}

  /** Records the billed prompt size of a request that sent the first `messageCount` messages. */
  public record(messageCount: number, promptTokens: number): void {
    this.anchor = promptTokens > 0 ? { tokens: promptTokens, messageCount } : null;
  }

  /** Drops the anchor once the messages it counted were rewritten. */
  public invalidate(): void {
    this.anchor = null;
  }

  public get anchored(): boolean {
    return this.anchor !== null;
  }

  public measure(messages: ChatMessage[]): number {
    if (this.anchor && messages.length >= this.anchor.messageCount) {
      return this.anchor.tokens + estimateMessagesTokens(messages.slice(this.anchor.messageCount));
    }
    return this.fixedTokens + estimateMessagesTokens(messages);
  }
}

export interface BudgetConfig {
  /** Spending cap for the whole PR review in USD (0 = unlimited). */
  maxCostUsd?: number;
  /** Context window used for compression decisions (default: 128,000). Not a spending limit. */
  maxContextTokens?: number;
  /** Fraction of the context window reserved for future background compression (default: 0.6). */
  softWatermark?: number;
  /** Fraction of the context window that triggers memory compression (default: 0.8). */
  warningWatermark?: number;
  roundTimeoutMs?: number; // Per-LLM-call timeout (default: 5 min; reasoning models can think for minutes)
  totalTimeoutMs?: number; // Wall-clock limit for the whole review (default: 30 min)
}

export interface UsageDelta {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Execution Budget Controller.
 *
 * Spending (USD) and wall-clock time are budgeted per PR review, but handed out to file groups as a
 * fair share of what is left: a group may use remaining / remainingGroups, so one expensive group
 * cannot starve the groups after it, and whatever a cheap group leaves rolls over to the next ones.
 * Token counts are tracked for reporting only; the context window drives compression, not spending.
 */
export class ExecutionBudgetController {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private startTime: number;
  private maxCostUsd: number;
  private maxContextTokens: number;
  public readonly roundTimeoutMs: number;
  private totalTimeoutMs: number;
  public readonly tokenSoftThreshold: number; // -> reserved: async compression
  public readonly tokenWarningThreshold: number; // -> sync compression

  private subtaskCostCeiling = Infinity;
  private subtaskDeadline = Infinity;

  constructor(config: BudgetConfig = {}) {
    this.maxCostUsd = config.maxCostUsd ?? 0;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.tokenSoftThreshold = config.softWatermark ?? 0.6;
    this.tokenWarningThreshold = config.warningWatermark ?? 0.8;
    this.roundTimeoutMs = config.roundTimeoutMs ?? 300_000;
    this.totalTimeoutMs = config.totalTimeoutMs ?? 1_800_000;
    this.startTime = Date.now();
    this.subtaskCostCeiling = this.maxCostUsd > 0 ? this.maxCostUsd : Infinity;
    this.subtaskDeadline = this.startTime + this.totalTimeoutMs;
  }

  public recordUsage(usage: UsageDelta): void {
    this.totalInputTokens += usage.promptTokens;
    this.totalOutputTokens += usage.completionTokens;
    this.totalCostUsd += usage.costUsd;
  }

  /** Allots the next subtask its fair share of the remaining cost and time budget. */
  public beginSubtask(remainingSubtasks: number, now = Date.now()): void {
    const n = Math.max(1, remainingSubtasks);
    this.subtaskCostCeiling =
      this.maxCostUsd > 0
        ? this.totalCostUsd + Math.max(0, this.maxCostUsd - this.totalCostUsd) / n
        : Infinity;
    const remainingMs = Math.max(0, this.startTime + this.totalTimeoutMs - now);
    this.subtaskDeadline = now + remainingMs / n;
  }

  public get inputTokensUsed(): number {
    return this.totalInputTokens;
  }

  public get outputTokensUsed(): number {
    return this.totalOutputTokens;
  }

  public get totalTokensUsed(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  public get costUsd(): number {
    return this.totalCostUsd;
  }

  public get maxContextWindow(): number {
    return this.maxContextTokens;
  }

  public get promptTokenLimit(): number {
    return Math.floor(this.maxContextTokens * this.tokenWarningThreshold);
  }

  public get softTokenLimit(): number {
    return Math.floor(this.maxContextTokens * this.tokenSoftThreshold);
  }

  public isCostBudgetExceeded(): boolean {
    return this.totalCostUsd >= this.subtaskCostCeiling;
  }

  public isTimedOut(now = Date.now()): boolean {
    return now >= this.subtaskDeadline;
  }

  /** `contextTokens` is the size of the next request, as measured by a {@link ContextMeter}. */
  public shouldCompress(contextTokens: number): boolean {
    return contextTokens > this.promptTokenLimit;
  }

  /** Reserved for non-blocking compression between the soft and warning watermarks; not wired yet. */
  public shouldTriggerAsyncCompression(contextTokens: number): boolean {
    return contextTokens > this.softTokenLimit && contextTokens <= this.promptTokenLimit;
  }
}
