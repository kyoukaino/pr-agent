import { Octokit } from "@octokit/rest";
import { isGeneratedOrLockfile, parseGitDiff } from "./domain/diff-parser.js";
import { groupTokenBudget, partitionFileGroups } from "./domain/grouping.js";
import { DiffAnchorRelocator } from "./domain/relocator.js";
import {
  buildFollowUpMessage,
  buildMainTaskMessages,
  buildReplyMessage,
  buildSystemPrompt,
  type PriorFinding,
} from "./domain/prompt.js";
import {
  routeToGroups,
  type OpenFinding,
  type ReviewSession,
  type SessionGroup,
} from "./domain/session.js";
import type { ParsedFileDiff } from "./domain/diff-parser.js";
import { CI_LOGS_MOUNT } from "./domain/tools.js";
import { ReviewPayloadAssembler } from "./domain/assembler.js";
import { createLLMClient, type LLMClient } from "./llm/client.js";
import { AgentRuntimeEngine, type ResolvedFinding } from "./runtime/engine.js";
import type { ChatMessage, MainLoopStop } from "./runtime/types.js";
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
  /** Findings posted by earlier reviews of this PR; the agent must not report them again. */
  previousFindings?: PriorFinding[];
  /**
   * Incremental re-review: only `rawDiff` (the changes since `sinceCommit`, the last reviewed
   * commit) is reviewed. The full PR diff in `rawDiff` above still anchors the comments.
   */
  incremental?: { sinceCommit: string; rawDiff: string };
  /**
   * Conversations of the review at `incremental.sinceCommit`: the new changes are appended to them
   * instead of starting new ones. Ignored without `incremental`.
   */
  session?: ReviewSession;
  /** Earlier findings still open on the PR; the agent closes the ones the code now fixes. */
  openFindings?: OpenFinding[];
  /**
   * Part of a PR's review session (GitHub App): offer resolve_finding and reply_to_author. One-off
   * reviews (CLI, benchmark) leave it unset and never see those tools.
   */
  sessionTools?: boolean;
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
  /** Open findings the agent verified as fixed. */
  resolvedFindings: ResolvedFinding[];
  /** Conversations as they ended, to continue on the next push. */
  session: ReviewSession;
}

export interface AnswerReplyOptions {
  owner: string;
  repo: string;
  pull_number: number;
  /** PR head the answer is checked against. */
  commit_id: string;
  /** The PR's diff; its files are the ones the agent may comment on. */
  rawDiff: string;
  repoDir?: string;
  /** The finding whose thread got the reply, with the posted comment as `body`. */
  finding: OpenFinding & { body: string };
  author: string;
  reply: string;
  /** The PR's review conversations; the answer continues the one that reviewed the file. */
  session?: ReviewSession;
  systemRule?: string;
  signal?: AbortSignal;
}

export interface AnswerReplyResult {
  /** Text to post in the thread; undefined if the agent gave none. */
  answer?: string;
  /** The agent agreed the finding is wrong or fixed. */
  resolved: boolean;
  /** The session with the exchange appended (undefined when none was given). */
  session?: ReviewSession;
  costUsd: number;
}

export class PRAgent {
  public readonly config: PRAgentConfig;
  private llmClient: LLMClient;
  private checkpointStore: CheckpointStore;

  constructor(userConfig: PRAgentUserConfig = {}) {
    this.config = PRAgentConfigSchema.parse(userConfig);
    this.llmClient = createLLMClient({
      protocol: this.config.protocol,
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

        // An incremental review covers only what changed since the last reviewed commit, limited to
        // files the PR changes (merging the base branch brings in others). Anchors still resolve
        // against the whole PR diff: GitHub accepts review comments only on its lines.
        const prPaths = new Set(prDiff.files.map((f) => f.path));
        const reviewFiles = options.incremental
          ? parseGitDiff(options.incremental.rawDiff).files.filter((f) => prPaths.has(f.path))
          : prDiff.files;
        const reviewScope = options.incremental
          ? `This PR was already reviewed at commit ${options.incremental.sinceCommit.slice(0, 7)}. The diffs below contain only the changes pushed since then; the rest of the PR was reviewed before. Review these changes, reading surrounding code as needed. Anchor findings on R<n> lines: L<n> here are lines of the previously reviewed commit, not of the PR base.`
          : undefined;

        // 3. Pre-flight Size Filtering (exclude single files exceeding warning watermark of max context tokens)
        const maxContextTokens =
          options.budgetConfig?.maxContextTokens || this.config.budget.maxContextTokens || 128_000;
        const warningWatermark =
          options.budgetConfig?.warningWatermark || this.config.budget.warningWatermark || 0.8;
        const promptTokenCeiling = Math.floor(maxContextTokens * warningWatermark);

        const skippedFiles: SkippedFile[] = [];
        const validDiffs = reviewFiles.filter((f) => {
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
          openFindingIds: options.openFindings?.map((f) => f.id),
          sessionTools: options.sessionTools,
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

        // 8. Dispatch per-group subtasks. A continued session appends the new changes to the
        // conversations that reviewed those files; otherwise every group starts a conversation
        // (groups already completed before a resume are skipped).
        const continued = options.incremental ? options.session : undefined;
        const sessionGroups: SessionGroup[] = continued ? [...continued.groups] : [];
        const tasks: { index: number; files: ParsedFileDiff[] }[] = [];
        if (continued) {
          for (const [index, files] of routeToGroups(sessionGroups, validDiffs)) {
            tasks.push({ index, files });
          }
        } else {
          for (const group of fileGroups) {
            if (resumeState?.completedSubtasks.has(group.label)) continue;
            sessionGroups.push({
              label: group.label,
              paths: group.files.map((f) => f.path),
              messages: [],
            });
            tasks.push({ index: sessionGroups.length - 1, files: group.files });
          }
        }

        const groups: GroupOutcome[] = [];
        const resolvedFindings: ResolvedFinding[] = [];
        for (const [i, task] of tasks.entries()) {
          const group = sessionGroups[task.index];
          const messages: ChatMessage[] = continued
            ? [
                ...group.messages,
                buildFollowUpMessage({
                  commit: options.commit_id,
                  sinceCommit: continued.reviewedCommit,
                  diffs: task.files,
                  ciResults: options.ciResults,
                  openFindings: options.openFindings ?? [],
                  confirmedComments: allComments,
                }),
              ]
            : buildMainTaskMessages({
                groupLabel: group.label,
                groupDiffs: task.files,
                allChangedPaths,
                background: options.background,
                ciResults: options.ciResults,
                confirmedComments: allComments,
                previousFindings: options.previousFindings,
                openFindings: options.openFindings,
                reviewScope,
                systemRule: combinedRules.length > 0 ? combinedRules : undefined,
              });

          const res = await engine.executeSubtask(group.label, messages, tasks.length - i);
          allComments.push(...res.comments);
          resolvedFindings.push(...res.resolved);
          sessionGroups[task.index] = {
            label: group.label,
            paths: [...new Set([...group.paths, ...task.files.map((f) => f.path)])],
            messages: res.messages,
          };
          groups.push({
            group: group.label,
            files: task.files.length,
            completed: res.completed,
            stopReason: res.stopReason,
            costUsd: res.costUsd,
            ...(res.error ? { error: res.error } : {}),
          });
        }
        const session: ReviewSession = {
          version: 1,
          model: this.llmClient.model,
          reviewedCommit: options.commit_id,
          groups: sessionGroups,
        };

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
          stillOpen: options.openFindings?.filter(
            (f) => !resolvedFindings.some((r) => r.id === f.id),
          ),
          resolvedCount: resolvedFindings.length,
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
          resolvedFindings,
          session,
        };
      });
    } catch (err) {
      runSpan.recordException(err as Error);
      runSpan.setAttribute("error", true);
      runSpan.end();
      throw err;
    }
  }

  /**
   * Answers an author's reply in the thread of a posted finding: the agent re-checks the code and
   * concedes (resolving the finding) or explains why the finding stands.
   */
  public async answerReply(options: AnswerReplyOptions): Promise<AnswerReplyResult> {
    const changedPaths = parseGitDiff(options.rawDiff).files.map((f) => f.path);
    const engine = new AgentRuntimeEngine({
      runId: `reply-${options.owner}-${options.repo}-${options.pull_number}-${Date.now()}`,
      repoDir: options.repoDir || process.cwd(),
      llmClient: this.llmClient,
      budgetConfig: this.config.budget,
      checkpointStore: this.checkpointStore,
      changedPaths,
      maxRounds: this.config.limits.maxRounds,
      openFindingIds: [options.finding.id],
      answeringReply: true,
      sessionTools: true,
      signal: options.signal,
    });

    // Continue the conversation that reviewed the file; without a session, start a small one.
    const groups = options.session ? [...options.session.groups] : [];
    const owner = groups.findIndex((g) => g.paths.includes(options.finding.path));
    const index = owner >= 0 ? owner : groups.length - 1;
    const rules = [...this.config.rules, ...(options.systemRule ? [options.systemRule] : [])];
    const history: ChatMessage[] =
      index >= 0
        ? groups[index].messages
        : [{ role: "system", content: buildSystemPrompt(rules.join("\n") || undefined) }];
    const message = buildReplyMessage({
      finding: options.finding,
      author: options.author,
      reply: options.reply,
      headCommit: options.commit_id,
    });

    const label = index >= 0 ? groups[index].label : "reply";
    const res = await engine.executeSubtask(label, [...history, message]);
    if (index >= 0) groups[index] = { ...groups[index], messages: res.messages };

    return {
      answer: res.replies.at(-1),
      resolved: res.resolved.some((r) => r.id === options.finding.id),
      session: options.session ? { ...options.session, groups } : undefined,
      costUsd: engine.costUsd,
    };
  }
}

export * from "./config/index.js";
export * from "./domain/github-types.js";
export type { PriorFinding } from "./domain/prompt.js";
export * from "./domain/session.js";
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
