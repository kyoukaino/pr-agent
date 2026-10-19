import { Octokit } from "@octokit/rest";
import { isGeneratedOrLockfile, parseGitDiff } from "./domain/diff-parser.js";
import { groupTokenBudget, partitionFileGroups } from "./domain/grouping.js";
import { DiffAnchorRelocator } from "./domain/relocator.js";
import { buildMainTaskMessages } from "./domain/prompt.js";
import { CI_LOGS_MOUNT } from "./domain/tools.js";
import { ReviewPayloadAssembler } from "./domain/assembler.js";
import { DeepSeekLLMClient } from "./llm/client.js";
import { AgentRuntimeEngine } from "./runtime/engine.js";
import type { MainLoopStop } from "./runtime/types.js";
import { CheckpointStore } from "./runtime/checkpoint.js";
import { RunTraceRecorder } from "./runtime/trace.js";
import { initTelemetry, AgentTelemetry } from "./telemetry/otel.js";
import { SqliteTraceStore } from "./telemetry/sqlite-store.js";
import type { EmittedComment, PRAgentReviewPayload } from "./domain/github-types.js";
import type { BudgetConfig } from "./runtime/budget.js";
import { countTokens } from "./runtime/budget.js";
import {
  PRAgentConfigSchema,
  type PRAgentConfig,
  type PRAgentUserConfig,
} from "./config/schema.js";

export interface ReviewPROptions {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  rawDiff: string;
  repoDir?: string;
  background?: string;
  /** Structured CI summary for the head commit (untrusted; rendered in a tagged prompt section). */
  ciResults?: string;
  /** Directory of failed CI job logs, readable by the agent under CI_LOGS_MOUNT. */
  ciLogsDir?: string;
  systemRule?: string;
  publishToGitHub?: boolean;
  githubToken?: string;
  resumeRunId?: string;
  budgetConfig?: BudgetConfig;
  phoenixEndpoint?: string;
  minSeverityToBlock?: "P0" | "P1" | "P2" | "P3";
  maxCommentsPerReview?: number;
  /** Aborts the review (e.g. when a newer commit supersedes this job). */
  signal?: AbortSignal;
}

export interface SkippedFile {
  path: string;
  reason: "generated_or_lockfile" | "no_text_hunks" | "too_large";
}

/** How one file group's review ended; anything but stopReason "none" means it was cut short. */
export interface GroupOutcome {
  group: string;
  files: number;
  completed: boolean;
  stopReason: MainLoopStop;
  costUsd: number;
  error?: string;
}

export interface ReviewRunResult {
  runId: string;
  payload: PRAgentReviewPayload;
  /** Raw findings as emitted by the agent, before relocation/truncation for GitHub. */
  findings: EmittedComment[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  durationMs: number;
  /** Files in the diff that were not sent to the model, and why. */
  skippedFiles: SkippedFile[];
  /** Groups reviewed in this run (groups already completed before a resume are not repeated). */
  groups: GroupOutcome[];
}

export class PRAgent {
  public readonly config: PRAgentConfig;
  private llmClient: DeepSeekLLMClient;
  private checkpointStore: CheckpointStore;

  constructor(userConfig: PRAgentUserConfig = {}) {
    this.config = PRAgentConfigSchema.parse(userConfig);
    this.llmClient = new DeepSeekLLMClient({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      model: this.config.model,
      temperature: this.config.temperature,
    });
    this.checkpointStore = new CheckpointStore();
  }

  public async reviewPR(options: ReviewPROptions): Promise<PRAgentReviewPayload> {
    return (await this.runReview(options)).payload;
  }

  public async runReview(options: ReviewPROptions): Promise<ReviewRunResult> {
    const startTime = Date.now();
    const runId =
      options.resumeRunId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const repoDir = options.repoDir || process.cwd();

    // 1. Initialize OpenTelemetry & Phoenix
    initTelemetry({
      enabled: this.config.telemetry.enabled,
      serviceName: this.config.telemetry.serviceName,
      phoenixEndpoint: options.phoenixEndpoint || this.config.telemetry.phoenixEndpoint,
    });

    const runSpan = AgentTelemetry.startAgentSpan("PRAgent.reviewPR", `PR #${options.pull_number}`);
    runSpan.setAttribute(
      "session.id",
      `pr-${options.owner}-${options.repo}-${options.pull_number}`,
    );

    try {
      return await AgentTelemetry.withSpan(runSpan, async () => {
        // 2. Parse Git Diff
        const prDiff = parseGitDiff(options.rawDiff);
        const relocator = new DiffAnchorRelocator(prDiff);

        // 3. Pre-flight Size Filtering (exclude single files exceeding warning watermark of max context tokens)
        const maxContextTokens =
          options.budgetConfig?.maxContextTokens || this.config.budget.maxContextTokens || 128_000;
        const warningWatermark =
          options.budgetConfig?.warningWatermark || this.config.budget.warningWatermark || 0.8;
        const promptTokenCeiling = Math.floor(maxContextTokens * warningWatermark);

        const skippedFiles: SkippedFile[] = [];
        const validDiffs = prDiff.files.filter((f) => {
          let reason: SkippedFile["reason"] | null = null;
          if (isGeneratedOrLockfile(f.path)) reason = "generated_or_lockfile";
          else if (f.hunkRanges.length === 0) reason = "no_text_hunks"; // binary, pure rename, mode change
          else if (countTokens(f.promptDiff) > promptTokenCeiling) reason = "too_large";
          if (reason) skippedFiles.push({ path: f.path, reason });
          return reason === null;
        });

        // 4. Group files: one group when the diff fits, token-bounded packing otherwise
        const fileGroups = partitionFileGroups(
          validDiffs,
          groupTokenBudget(maxContextTokens, warningWatermark),
        );

        // 5. Initialize Checkpoints & Resume State
        this.checkpointStore.appendEvent(runId, "RUN_START", {
          owner: options.owner,
          repo: options.repo,
          pull_number: options.pull_number,
          commit_id: options.commit_id,
          filesCount: prDiff.files.length,
          groupsCount: fileGroups.length,
          model: this.config.model,
        });

        let resumeState = null;
        if (options.resumeRunId) {
          resumeState = await this.checkpointStore.loadResumeState(options.resumeRunId);
        }

        const traceRecorder = new RunTraceRecorder(
          runId,
          `${options.owner}/${options.repo}`,
          options.commit_id,
          this.llmClient.model,
        );

        // 6. Merge Budget Config
        const effectiveBudget: BudgetConfig = {
          maxCostUsd: options.budgetConfig?.maxCostUsd ?? this.config.budget.maxCostUsd,
          maxContextTokens,
          softWatermark: options.budgetConfig?.softWatermark || this.config.budget.softWatermark,
          warningWatermark:
            options.budgetConfig?.warningWatermark || this.config.budget.warningWatermark,
          roundTimeoutMs: options.budgetConfig?.roundTimeoutMs || this.config.budget.roundTimeoutMs,
          totalTimeoutMs: options.budgetConfig?.totalTimeoutMs || this.config.budget.totalTimeoutMs,
        };

        // 7. Initialize Runtime Engine
        const engine = new AgentRuntimeEngine({
          runId,
          repoDir,
          llmClient: this.llmClient,
          budgetConfig: effectiveBudget,
          checkpointStore: this.checkpointStore,
          traceRecorder,
          resumeState: resumeState || undefined,
          changedPaths: prDiff.files.map((f) => f.path),
          maxRounds: this.config.limits.maxRounds,
          mounts: options.ciLogsDir ? { [CI_LOGS_MOUNT]: options.ciLogsDir } : undefined,
          signal: options.signal,
        });

        const allChangedPaths = prDiff.files.map((f) => f.path);
        const allComments: EmittedComment[] = resumeState
          ? [...resumeState.accumulatedComments]
          : [];

        // System rule assembly (configured rules + options.systemRule)
        const combinedRules = [
          ...this.config.rules,
          ...(options.systemRule ? [options.systemRule] : []),
        ].join("\n");

        // 8. Dispatch per-group subtasks (already completed ones are skipped on resume)
        const pendingGroups = fileGroups.filter(
          (g) => !resumeState?.completedSubtasks.has(g.label),
        );
        const groups: GroupOutcome[] = [];
        for (const [i, group] of pendingGroups.entries()) {
          const initialMessages = buildMainTaskMessages({
            groupLabel: group.label,
            groupDiffs: group.files,
            allChangedPaths,
            background: options.background,
            ciResults: options.ciResults,
            confirmedComments: allComments,
            systemRule: combinedRules.length > 0 ? combinedRules : undefined,
          });

          const res = await engine.executeSubtask(
            group.label,
            initialMessages,
            pendingGroups.length - i,
          );
          allComments.push(...res.comments);
          groups.push({
            group: group.label,
            files: group.files.length,
            completed: res.completed,
            stopReason: res.stopReason,
            costUsd: res.costUsd,
            ...(res.error ? { error: res.error } : {}),
          });
        }

        // 9. Assemble final GitHub Create Review Payload
        const reviewPayload = ReviewPayloadAssembler.assemble({
          owner: options.owner,
          repo: options.repo,
          pull_number: options.pull_number,
          commit_id: options.commit_id,
          comments: allComments,
          relocator,
          totalTokensUsed: engine.totalTokensUsed,
          costUsd: engine.costUsd,
          minSeverityToBlock: options.minSeverityToBlock || this.config.review.minSeverityToBlock,
          maxCommentsPerReview:
            options.maxCommentsPerReview || this.config.review.maxCommentsPerReview,
          skippedFiles,
          incompleteGroups: groups.filter((g) => g.error).map((g) => g.group),
        }) as PRAgentReviewPayload;

        // 10. Optional GitHub Publishing
        if (options.publishToGitHub) {
          const token = options.githubToken || process.env.GITHUB_TOKEN;
          if (!token) {
            throw new Error("Cannot publish review: GITHUB_TOKEN is not provided.");
          }
          const octokit = new Octokit({ auth: token });
          await octokit.rest.pulls.createReview(reviewPayload);
        }

        // 11. Finalize Trace & Checkpoint
        traceRecorder.finalize(allComments.length);
        this.checkpointStore.appendEvent(runId, "RUN_END", {
          finalEvent: reviewPayload.event,
          commentsCount: allComments.length,
          totalTokensUsed: engine.totalTokensUsed,
          costUsd: engine.costUsd,
        });

        const durationMs = Date.now() - startTime;
        const promptTokens = engine.inputTokensUsed;
        const completionTokens = engine.outputTokensUsed;

        try {
          const sqliteStore = new SqliteTraceStore();
          sqliteStore.recordRun(
            {
              id: runId,
              repo: `${options.owner}/${options.repo}`,
              pr_number: options.pull_number,
              commit_id: options.commit_id,
              created_at: new Date(startTime).toISOString(),
              status: "completed",
              event: reviewPayload.event,
              duration_ms: durationMs,
              total_tokens: engine.totalTokensUsed,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              cost_usd: engine.costUsd,
              raw_diff: options.rawDiff,
              comments_json: JSON.stringify(allComments),
              metrics_json: JSON.stringify({
                model: this.config.model,
                filesCount: prDiff.files.length,
                groupsCount: fileGroups.length,
                skippedFiles,
                groups,
              }),
            },
            traceRecorder.manifestSnapshot,
          );
        } catch {
          // Continue even if SQLite store insert fails
        }

        runSpan.setAttribute("pr.review_event", reviewPayload.event);
        runSpan.setAttribute("pr.comments_count", allComments.length);
        runSpan.setAttribute("pr.tokens_used", engine.totalTokensUsed);
        runSpan.end();

        return {
          runId,
          payload: reviewPayload,
          findings: allComments,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: engine.totalTokensUsed,
            costUsd: engine.costUsd,
          },
          durationMs,
          skippedFiles,
          groups,
        };
      });
    } catch (err) {
      runSpan.recordException(err as Error);
      runSpan.setAttribute("error", true);
      runSpan.end();
      throw err;
    }
  }
}

export * from "./config/index.js";
export * from "./domain/github-types.js";
export * from "./domain/diff-parser.js";
export * from "./domain/relocator.js";
export * from "./domain/grouping.js";
export * from "./domain/compression.js";
export * from "./domain/assembler.js";
export * from "./runtime/engine.js";
export * from "./runtime/budget.js";
export * from "./runtime/checkpoint.js";
export * from "./runtime/trace.js";
export * from "./runtime/retry.js";
export * from "./runtime/cancellation.js";
export * from "./llm/client.js";
export * from "./llm/pricing.js";
export * from "./telemetry/otel.js";
export * from "./telemetry/sqlite-store.js";
export * from "./github-app/index.js";
