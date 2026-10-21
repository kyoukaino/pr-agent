import type { LLMClient, LLMResponse } from "../llm/client.js";
import { MainLoopStop, type ChatMessage, type ToolResult } from "./types.js";
import { ExecutionBudgetController, type BudgetConfig } from "./budget.js";
import { MemoryCompressor } from "../domain/compression.js";
import { ToolFailureStreakTracker } from "./retry.js";
import { TaskCancellationTree } from "./cancellation.js";
import { CheckpointStore, type ResumeState } from "./checkpoint.js";
import { RunTraceRecorder } from "./trace.js";
import { ToolDispatcher, toolDefinitionsFor } from "../domain/tools.js";
import type { EmittedComment } from "../domain/github-types.js";
import { AgentTelemetry } from "../telemetry/otel.js";

export interface AgentRuntimeOptions {
  runId: string;
  repoDir: string;
  llmClient: LLMClient;
  budgetConfig?: BudgetConfig;
  checkpointStore?: CheckpointStore;
  traceRecorder?: RunTraceRecorder;
  resumeState?: ResumeState;
  /** Paths changed by the PR; code_comment is restricted to them. */
  changedPaths?: string[];
  /** Read-only directories exposed to read_file / grep_code under a path prefix (e.g. CI logs). */
  mounts?: Record<string, string>;
  /** Safety backstop: max ReAct rounds per subtask (default 100). Not part of the budget. */
  maxRounds?: number;
  /** External cancellation (e.g. a superseded webhook job). */
  signal?: AbortSignal;
  onCommentEmitted?: (comment: EmittedComment) => void;
  /** Ids of findings posted by earlier reviews that resolve_finding may close. */
  openFindingIds?: string[];
  /** Answering an author's reply in a finding thread: enables reply_to_author. */
  answeringReply?: boolean;
  /**
   * Offer the session tools (resolve_finding, reply_to_author): set for every run of a PR's review
   * session (GitHub App), so the tool set, and with it the prompt-cache prefix, never changes.
   */
  sessionTools?: boolean;
}

export interface ResolvedFinding {
  id: string;
  reason: string;
}

export interface SubtaskResult {
  completed: boolean;
  stopReason: MainLoopStop;
  /** Spend of this subtask alone, in USD. */
  costUsd: number;
  comments: EmittedComment[];
  /** Earlier findings the agent verified as fixed. */
  resolved: ResolvedFinding[];
  /** Answers to the author's reply (when answeringReply). */
  replies: string[];
  /** The conversation as it ended; a later follow-up continues from it. */
  messages: ChatMessage[];
  error?: string;
}

const GRACE_ROUND_TOOLS = new Set([
  "code_comment",
  "resolve_finding",
  "reply_to_author",
  "task_done",
]);

export class AgentRuntimeEngine {
  public readonly runId: string;
  private repoDir: string;
  private llmClient: LLMClient;
  private budget: ExecutionBudgetController;
  private compressor: MemoryCompressor;
  private streakTracker = new ToolFailureStreakTracker(3);
  private cancellation: TaskCancellationTree;
  private checkpointStore?: CheckpointStore;
  private traceRecorder?: RunTraceRecorder;
  private changedPaths?: string[];
  private mounts?: Record<string, string>;
  private maxRounds: number;
  private openFindingIds: Set<string>;
  private answeringReply: boolean;
  private tools: ReturnType<typeof toolDefinitionsFor>;
  private resolvedIds = new Set<string>();
  private accumulatedComments: EmittedComment[] = [];
  private onCommentCallback?: (comment: EmittedComment) => void;

  constructor(options: AgentRuntimeOptions, parentCancellation?: TaskCancellationTree) {
    this.runId = options.runId;
    this.repoDir = options.repoDir;
    this.llmClient = options.llmClient;
    this.budget = new ExecutionBudgetController(options.budgetConfig);
    this.compressor = new MemoryCompressor(this.llmClient);
    this.cancellation = new TaskCancellationTree(parentCancellation);
    this.checkpointStore = options.checkpointStore;
    this.traceRecorder = options.traceRecorder;
    this.changedPaths = options.changedPaths;
    this.mounts = options.mounts;
    this.maxRounds = options.maxRounds ?? 100;
    this.openFindingIds = new Set(options.openFindingIds ?? []);
    this.answeringReply = options.answeringReply ?? false;
    this.tools = toolDefinitionsFor(options.sessionTools ?? false);
    this.onCommentCallback = options.onCommentEmitted;

    if (options.signal) {
      if (options.signal.aborted) this.cancel(String(options.signal.reason ?? "aborted"));
      else
        options.signal.addEventListener(
          "abort",
          () => this.cancel(String(options.signal!.reason)),
          {
            once: true,
          },
        );
    }

    if (options.resumeState) {
      this.accumulatedComments = [...options.resumeState.accumulatedComments];
      this.budget.recordUsage(options.resumeState.usage);
    }
  }

  public get signal(): AbortSignal {
    return this.cancellation.signal;
  }

  public cancel(reason?: string): void {
    this.cancellation.abort(reason);
  }

  public get totalTokensUsed(): number {
    return this.budget.totalTokensUsed;
  }

  public get inputTokensUsed(): number {
    return this.budget.inputTokensUsed;
  }

  public get outputTokensUsed(): number {
    return this.budget.outputTokensUsed;
  }

  public get costUsd(): number {
    return this.budget.costUsd;
  }

  private get usageSnapshot() {
    return {
      promptTokens: this.budget.inputTokensUsed,
      completionTokens: this.budget.outputTokensUsed,
      costUsd: this.budget.costUsd,
    };
  }

  public get comments(): EmittedComment[] {
    return this.accumulatedComments;
  }

  /** One LLM step bounded by the per-round timeout and the run's cancellation signal. */
  private async callModel(messages: ChatMessage[]): Promise<LLMResponse> {
    const response = await this.llmClient.chatCompletion(messages, this.tools, this.signal, {
      timeoutMs: this.budget.roundTimeoutMs,
    });
    this.budget.recordUsage(response.usage);
    return response;
  }

  /**
   * Executes the ReAct tool-use loop for one subtask/file group.
   * `remainingSubtasks` (this one included) sizes its fair share of the remaining cost and time budget.
   */
  public async executeSubtask(
    subtaskKey: string,
    initialMessages: ChatMessage[],
    remainingSubtasks = 1,
    maxRounds = this.maxRounds,
  ): Promise<SubtaskResult> {
    this.budget.beginSubtask(remainingSubtasks);
    const costAtStart = this.budget.costUsd;
    const span = AgentTelemetry.startAgentSpan(`subtask.${subtaskKey}`);
    return await AgentTelemetry.withSpan(span, async () => {
      let messages = [...initialMessages];
      let roundsLeft = maxRounds;
      let stopReason = MainLoopStop.StopNone;
      let completed = false;
      let consecutiveEmptyRounds = 0;
      let error: string | undefined;

      const subtaskComments: EmittedComment[] = [];
      const subtaskResolved: ResolvedFinding[] = [];
      const subtaskReplies: string[] = [];

      const toolDispatcher = new ToolDispatcher({
        repoDir: this.repoDir,
        changedPaths: this.changedPaths,
        mounts: this.mounts,
        signal: this.signal,
        onCommentEmitted: (comment) => {
          subtaskComments.push(comment);
          this.accumulatedComments.push(comment);
          this.onCommentCallback?.(comment);
          this.checkpointStore?.appendEvent(this.runId, "COMMENT_EMITTED", {
            subtaskKey,
            comment,
          });
        },
        openFindingIds: this.openFindingIds,
        resolvedFindingIds: this.resolvedIds,
        onFindingResolved: (resolved) => {
          subtaskResolved.push(resolved);
          this.checkpointStore?.appendEvent(this.runId, "FINDING_RESOLVED", {
            subtaskKey,
            ...resolved,
          });
        },
        onAuthorReply: this.answeringReply ? (m) => subtaskReplies.push(m) : undefined,
      });

      try {
        while (roundsLeft > 0) {
          if (this.signal.aborted) {
            throw new Error(`Subtask aborted: ${this.signal.reason}`);
          }

          // Budget Gate 1: this subtask's share of the review's cost budget
          if (this.budget.isCostBudgetExceeded()) {
            stopReason = MainLoopStop.StopCostBudget;
            break;
          }

          // Budget Gate 2: this subtask's share of the wall-clock budget
          if (this.budget.isTimedOut()) {
            stopReason = MainLoopStop.StopTimeout;
            break;
          }

          // Memory compression once the context crosses the watermark. Checked before every model
          // call, so a continued session whose follow-up pushed it over is compressed first.
          if (this.budget.shouldCompress(messages)) {
            const compressed = await this.compressor.compress(messages, {
              maxContextTokens: this.budget.maxContextWindow,
              warningThreshold: this.budget.tokenWarningThreshold,
              signal: this.signal,
              timeoutMs: this.budget.roundTimeoutMs,
            });
            if (compressed.usage) this.budget.recordUsage(compressed.usage);
            messages = compressed.messages;
            if (this.budget.shouldCompress(messages)) {
              // Still exceeds threshold after compression: stop loop safely
              stopReason = MainLoopStop.StopCompression;
              break;
            }
          }

          roundsLeft--;
          const turnStartedAt = new Date();

          // 1. LLM Step
          const response = await this.callModel(messages);
          const toolCalls = response.toolCalls || [];

          if (toolCalls.length === 0) {
            consecutiveEmptyRounds++;
            if (consecutiveEmptyRounds >= 3) {
              stopReason = MainLoopStop.StopEmptyRounds;
              break;
            }
            messages.push({
              role: "assistant",
              content: response.content,
              reasoning_content: response.reasoningContent,
            });
            messages.push({
              role: "user",
              content:
                "You did not call any tools. Please call tools (code_comment, read_file, grep_code) or call task_done if finished.",
            });
            continue;
          }

          consecutiveEmptyRounds = 0;
          const llmDurationMs = Date.now() - turnStartedAt.getTime();

          // 2. Append assistant turn
          messages.push({
            role: "assistant",
            content: response.content,
            reasoning_content: response.reasoningContent,
            tool_calls: toolCalls,
          });

          // 3. Tool Execution Step. Tool errors are reported back to the model (it can correct the
          // call); only task_done ends the subtask, and repeated failures trip the streak tracker.
          const toolResults: ToolResult[] = [];
          let doneSignal: { completed: boolean } | null = null;

          for (const tc of toolCalls) {
            const fnName = tc.function.name;
            const toolStartedAt = Date.now();

            let resultText: string;
            if (this.streakTracker.isTripwire(subtaskKey, fnName)) {
              resultText = `Error: tool '${fnName}' has repeatedly failed consecutive calls. Action skipped.`;
            } else {
              const res = await toolDispatcher.execute(fnName, tc.function.arguments);
              resultText = res.result;
              if (res.failed) this.streakTracker.recordFailure(subtaskKey, fnName);
              else this.streakTracker.reset(subtaskKey, fnName);
              if (res.done) doneSignal = { completed: Boolean(res.completed) };
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
            toolResults.push({
              toolCallId: tc.id,
              toolName: fnName,
              result: resultText,
              durationMs: Date.now() - toolStartedAt,
            });
          }

          this.traceRecorder?.recordTurn({
            turnNumber: maxRounds - roundsLeft,
            subtaskKey,
            startedAt: turnStartedAt.toISOString(),
            requestMessages: messages.slice(-2),
            responseContent: response.content,
            reasoningContent: response.reasoningContent,
            toolCalls,
            toolResults,
            usage: response.usage,
            durationMs: llmDurationMs,
          });

          if (doneSignal) {
            completed = doneSignal.completed;
            stopReason = MainLoopStop.StopNone;
            break;
          }
        }

        if (roundsLeft === 0 && !completed && stopReason === MainLoopStop.StopNone) {
          stopReason = MainLoopStop.StopMaxRounds;
        }

        // Grace Round Execution if budget, time or rounds were spent
        if (
          stopReason === MainLoopStop.StopMaxRounds ||
          stopReason === MainLoopStop.StopCostBudget ||
          stopReason === MainLoopStop.StopTimeout
        ) {
          completed = await this.runGraceRound(subtaskKey, messages, toolDispatcher);
        }
      } catch (err) {
        // Cancellation propagates; an LLM failure ends only this subtask so findings from other
        // groups (and comments already emitted here) are kept.
        if (this.signal.aborted) {
          span.recordException(err as Error);
          span.setAttribute("error", true);
          span.end();
          throw err;
        }
        stopReason = MainLoopStop.StopLLMError;
        error = (err as Error).message;
        span.recordException(err as Error);
      }

      this.checkpointStore?.appendEvent(this.runId, "SUBTASK_DONE", {
        subtaskKey,
        completed,
        stopReason,
        usage: this.usageSnapshot,
        ...(error ? { error } : {}),
      });

      span.setAttribute("subtask.completed", completed);
      span.setAttribute("subtask.stop_reason", stopReason);
      span.end();

      return {
        completed,
        stopReason,
        costUsd: this.budget.costUsd - costAtStart,
        comments: subtaskComments,
        resolved: subtaskResolved,
        replies: subtaskReplies,
        messages,
        error,
      };
    });
  }

  /**
   * Final Grace Round: Gives the model one last chance to submit any pending code comments
   * before terminating, with tools restricted strictly to code_comment and task_done.
   */
  private async runGraceRound(
    subtaskKey: string,
    messages: ChatMessage[],
    toolDispatcher: ToolDispatcher,
  ): Promise<boolean> {
    const offered = new Set(this.tools.map((t) => t.function.name));
    const graceTools = [...GRACE_ROUND_TOOLS].filter((t) => offered.has(t));
    messages.push({
      role: "user",
      content: `Your review budget is exhausted. This is your FINAL grace round. You may ONLY call ${graceTools
        .map((t) => `'${t}'`)
        .join(
          ", ",
        )}: record the findings, fixes or answer you have verified, then finish. No other tools are available.`,
    });

    try {
      // Keep the tool definitions intact to preserve LLM KV prefix cache (avoid busting DeepSeek Prompt Cache).
      // Tool usage restriction is enforced via prompt instruction and runtime execution filter.
      const startedAt = new Date();
      const response = await this.callModel(messages);
      const llmDurationMs = Date.now() - startedAt.getTime();

      let isCompleted = false;
      const toolResults: ToolResult[] = [];
      const toolCalls = response.toolCalls || [];
      // The turn stays in the conversation so a later follow-up continues from a well-formed history:
      // every tool call gets a result, skipped ones included.
      messages.push({
        role: "assistant",
        content: response.content,
        reasoning_content: response.reasoningContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      for (const tc of toolCalls) {
        if (!graceTools.includes(tc.function.name)) {
          // Guard: ignore exploratory tools in grace round without busting tool schema cache
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Skipped: only ${graceTools.join(", ")} run in the grace round.`,
          });
          continue;
        }
        const toolStartedAt = Date.now();
        const res = await toolDispatcher.execute(tc.function.name, tc.function.arguments);
        messages.push({ role: "tool", tool_call_id: tc.id, content: res.result });
        toolResults.push({
          toolCallId: tc.id,
          toolName: tc.function.name,
          result: res.result,
          durationMs: Date.now() - toolStartedAt,
        });
        if (res.done && res.completed) isCompleted = true;
      }

      // Recorded like any other turn: it is often the most expensive call of the run.
      this.traceRecorder?.recordTurn({
        turnNumber: -1,
        subtaskKey: `${subtaskKey} (grace)`,
        startedAt: startedAt.toISOString(),
        requestMessages: messages.slice(-1),
        responseContent: response.content,
        reasoningContent: response.reasoningContent,
        toolCalls: response.toolCalls,
        toolResults,
        usage: response.usage,
        durationMs: llmDurationMs,
      });

      return isCompleted;
    } catch {
      return false;
    }
  }
}
