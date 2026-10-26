import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import * as os from "node:os";
import { Redis } from "ioredis";
import pc from "picocolors";
import { PRAgent } from "../index.js";
import { parseGitDiff } from "../domain/diff-parser.js";
import { loadConfig } from "../config/loader.js";
import { TaskCancellationTree } from "../runtime/cancellation.js";
import type { GitHubAppConfig } from "./config.js";
import type { PRReviewJobData, PRReviewQueueManager } from "./queue.js";
import type { GitHubAppAuthManager } from "./auth.js";
import { CI_LOGS_MOUNT } from "../domain/workspace.js";
import { collectCiContext, fetchCiSnapshot, shouldWaitForCi } from "./ci.js";
import { isPushedOnTop, loadReviewHistory } from "./history.js";
import { preparePRContext } from "./pr-context.js";
import { loadOpenFindings, resolveFindingThreads, resolveThread } from "./threads.js";
import type { PRSessionStore } from "./session-store.js";

const PR_LOCK_RETRY_MS = 15_000;

export class PRReviewWorker {
  private worker: Worker<PRReviewJobData>;
  private subRedis: Redis;
  private activeTasks: Map<string, TaskCancellationTree> = new Map();

  constructor(
    private config: GitHubAppConfig,
    private authManager: GitHubAppAuthManager,
    private queueManager: PRReviewQueueManager,
    private sessionStore: PRSessionStore,
  ) {
    const redisOptions = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
    };

    this.subRedis = new Redis(redisOptions);

    // 1. Listen for stale cancellation signals via Redis Pub/Sub
    this.subRedis.subscribe("pr-agent:cancel", (err) => {
      if (err) {
        console.error(pc.red(`[Worker] Failed to subscribe to cancel channel: ${err.message}`));
      }
    });

    this.subRedis.on("message", (channel, message) => {
      if (channel === "pr-agent:cancel") {
        try {
          const { jobId, reason } = JSON.parse(message);
          const activeTree = this.activeTasks.get(jobId);
          if (activeTree) {
            console.log(pc.yellow(`[Worker] Aborting stale job ${jobId} (Reason: ${reason})`));
            activeTree.abort(reason || "Canceled by newer commit");
          }
        } catch {
          // ignore malformed cancel messages
        }
      }
    });

    // 2. Initialize BullMQ Worker (rate limiting is a worker option in BullMQ)
    this.worker = new Worker<PRReviewJobData>(
      "pr-agent-reviews",
      async (job: Job<PRReviewJobData>, token?: string) => {
        return this.processJob(job, token);
      },
      {
        connection: queueManager.redis,
        concurrency: config.rateLimit.maxConcurrentReviews,
        limiter: { max: config.rateLimit.maxReviewsPerMinute, duration: 60_000 },
      },
    );

    this.worker.on("failed", (job, err) => {
      console.error(pc.red(`[Worker] Job ${job?.id} failed: ${err.message}`));
    });

    this.worker.on("completed", (job) => {
      console.log(pc.green(`[Worker] Job ${job.id} completed successfully!`));
    });
  }

  /** Re-queues the job shortly when another job of the same PR holds its lock. */
  private async waitForPRLock(job: Job<PRReviewJobData>, bullToken?: string): Promise<void> {
    const { owner, repo, pull_number, jobId } = job.data;
    if (await this.queueManager.acquirePRLock(owner, repo, pull_number, jobId)) return;
    await job.moveToDelayed(Date.now() + PR_LOCK_RETRY_MS, bullToken);
    throw new DelayedError();
  }

  private async processJob(job: Job<PRReviewJobData>, bullToken?: string): Promise<void> {
    if (job.data.reply) return this.processReply(job, bullToken);
    const data = job.data;
    const isCurrent = async () =>
      (await this.queueManager.getActiveJob(data.owner, data.repo, data.pull_number)) ===
      data.jobId;

    // A newer commit may have been pushed while this job waited in the queue; the cancel broadcast
    // only reaches jobs that are already running, so check the active marker explicitly.
    if (!(await isCurrent())) {
      console.log(pc.yellow(`[Worker] Skipping superseded job ${data.jobId}`));
      return;
    }

    const cancellationTree = new TaskCancellationTree();
    this.activeTasks.set(data.jobId, cancellationTree);
    let cleanup: (() => Promise<void>) | undefined;
    let ciCleanup: (() => void) | undefined;
    // The active marker is cleared only when no retry will follow; a retry must still see itself as current.
    let finished = false;

    try {
      // 1. Authenticate with GitHub App Installation Token
      const { octokit, token } = await this.authManager.getInstallationClient(data.installationId);

      // 2. Wait for the head commit's CI: re-check every poll interval until nothing is running or
      // the deadline passes. Delaying the job does not count as an attempt.
      const ciSnapshot = await fetchCiSnapshot(octokit, data.owner, data.repo, data.commit_id);
      if (shouldWaitForCi(ciSnapshot, Date.now(), data.ciDeadline)) {
        await job.moveToDelayed(Date.now() + this.config.ciWait.pollIntervalMs, bullToken);
        throw new DelayedError();
      }

      console.log(
        pc.cyan(
          `\n[Worker] Processing PR Review for ${data.owner}/${data.repo}#${data.pull_number} (Commit: ${data.commit_id.slice(0, 7)})...`,
        ),
      );

      // Reviews and reply answers of this PR share its conversations: one at a time.
      await this.waitForPRLock(job, bullToken);

      // 3. Earlier reviews by this App: a push after a review is reviewed incrementally, the
      // findings already posted are never repeated, and open ones can be resolved once fixed.
      const botLogin = await this.authManager.getBotLogin();
      const history = await loadReviewHistory(
        octokit,
        data.owner,
        data.repo,
        data.pull_number,
        botLogin,
      );
      if (history.lastReviewedCommit === data.commit_id) {
        console.log(pc.yellow(`[Worker] Commit ${data.commit_id.slice(0, 7)} already reviewed.`));
        finished = true;
        return;
      }
      const pushedOnTop = history.lastReviewedCommit
        ? await isPushedOnTop(
            octokit,
            data.owner,
            data.repo,
            history.lastReviewedCommit,
            data.commit_id,
          )
        : false;
      const openFindings = await loadOpenFindings(
        octokit,
        data.owner,
        data.repo,
        data.pull_number,
        botLogin,
      );
      const openTitles = new Set(openFindings.map((f) => f.title));
      const previousFindings = history.findings.filter((f) => !openTitles.has(f.title));

      // 4. PR description and CI results give the agent the author's intent and objective evidence.
      const { data: pull } = await octokit.rest.pulls.get({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pull_number,
      });
      const background = `PR title: ${pull.title}\n\n${(pull.body ?? "").slice(0, 4000)}`.trim();
      const ci = await collectCiContext(octokit, data.owner, data.repo, ciSnapshot, os.tmpdir());
      ciCleanup = ci.cleanup;

      // 5. Check out the PR head with its merge base (and the last reviewed commit) so the diffs
      // are computed locally, whatever the PR size, and context tools read the code under review.
      const ctx = await preparePRContext({
        octokit,
        token,
        owner: data.owner,
        repo: data.repo,
        pullNumber: data.pull_number,
        headSha: data.commit_id,
        baseSha: pull.base.sha,
        sinceCommit: pushedOnTop ? history.lastReviewedCommit : undefined,
        rawDiff: data.rawDiff,
        prInfo: { title: pull.title, body: pull.body },
        signal: cancellationTree.signal,
      });
      cleanup = ctx.cleanup;
      const { rawDiff, incrementalDiff } = ctx;
      console.log(pc.gray(`[Worker] PR diff from ${ctx.diffSource}.`));

      if (!rawDiff.trim()) {
        console.log(pc.yellow(`[Worker] No diff content for PR #${data.pull_number}. Skipping.`));
        finished = true;
        return;
      }

      // Pushes since the last review that touch no file of the PR (e.g. merging the base branch)
      // leave nothing new to review.
      if (incrementalDiff !== undefined) {
        const prPaths = new Set(parseGitDiff(rawDiff).files.map((f) => f.path));
        if (!parseGitDiff(incrementalDiff).files.some((f) => prPaths.has(f.path))) {
          console.log(pc.yellow(`[Worker] No PR changes since the last review. Skipping.`));
          finished = true;
          return;
        }
      }

      // 7. Instantiate PR-Agent with the project configuration (rules, budget, policy)
      const { config } = await loadConfig({
        overrides: { model: data.model || this.config.model },
      });
      const agent = new PRAgent(config);

      // The saved conversations continue only if they ended exactly at the last posted review and
      // used the same model; otherwise the review starts fresh from GitHub's record.
      const saved = this.sessionStore.load(data.owner, data.repo, data.pull_number);
      const session =
        incrementalDiff !== undefined &&
        saved?.reviewedCommit === history.lastReviewedCommit &&
        saved?.model === config.model
          ? saved
          : undefined;

      // 8. Run autonomous review; a cancel broadcast aborts it mid-flight
      const result = await agent.runReview({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pull_number,
        commit_id: data.commit_id,
        rawDiff,
        repoDir: ctx.dir,
        background,
        ciResults: ci.summary || undefined,
        mounts: { ...ctx.mounts, ...(ci.logsDir ? { [CI_LOGS_MOUNT]: ci.logsDir } : {}) },
        previousFindings,
        openFindings,
        session,
        sessionTools: true,
        incremental:
          incrementalDiff !== undefined && history.lastReviewedCommit
            ? { sinceCommit: history.lastReviewedCommit, rawDiff: incrementalDiff }
            : undefined,
        signal: cancellationTree.signal,
      });
      const reviewPayload = result.payload;

      if (cancellationTree.isAborted || !(await isCurrent())) {
        console.log(
          pc.yellow(`[Worker] Review completed but job was superseded. Discarding review.`),
        );
        finished = true;
        return;
      }

      // 9. Post review payload directly to GitHub
      console.log(
        pc.green(
          `[Worker] Posting review to GitHub (${reviewPayload.event}, ${reviewPayload.comments.length} comments, ${session ? "continued" : "new"} session)...`,
        ),
      );
      await octokit.rest.pulls.createReview(reviewPayload);
      finished = true;
      this.sessionStore.save(data.owner, data.repo, data.pull_number, result.session);

      // 10. Close the threads of findings the agent verified as fixed
      if (result.resolvedFindings.length > 0) {
        try {
          const n = await resolveFindingThreads(
            octokit,
            data.owner,
            data.repo,
            data.pull_number,
            data.commit_id,
            openFindings,
            result.resolvedFindings,
          );
          console.log(pc.green(`[Worker] Resolved ${n} fixed finding(s).`));
        } catch (err) {
          console.error(pc.yellow(`[Worker] Resolving threads failed: ${(err as Error).message}`));
        }
      }
    } catch (err) {
      // Waiting for CI: the job comes back later and must still own the active marker.
      if (err instanceof DelayedError) throw err;
      finished = cancellationTree.isAborted || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // A superseded job must not be retried by BullMQ.
      if (cancellationTree.isAborted) {
        throw new UnrecoverableError(
          `Job ${data.jobId} cancelled: ${String(cancellationTree.signal.reason)}`,
        );
      }
      throw err;
    } finally {
      this.activeTasks.delete(data.jobId);
      await cleanup?.().catch(() => undefined);
      ciCleanup?.();
      await this.queueManager
        .releasePRLock(data.owner, data.repo, data.pull_number, data.jobId)
        .catch(() => undefined);
      if (finished) {
        await this.queueManager
          .clearActiveJob(data.owner, data.repo, data.pull_number, data.jobId)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Answers a reply in the thread of one of this App's findings: the agent re-checks the code at
   * the PR head, then the answer is posted in the thread, which is resolved if the agent concedes.
   */
  private async processReply(job: Job<PRReviewJobData>, bullToken?: string): Promise<void> {
    const data = job.data;
    const reply = data.reply!;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const { octokit, token } = await this.authManager.getInstallationClient(data.installationId);
      const botLogin = await this.authManager.getBotLogin();
      const { data: root } = await octokit.rest.pulls.getReviewComment({
        owner: data.owner,
        repo: data.repo,
        comment_id: reply.rootCommentId,
      });
      if (root.user?.login !== botLogin) return; // a thread someone else started

      await this.waitForPRLock(job, bullToken);

      // Only open findings are discussed; a resolved thread is settled.
      const open = await loadOpenFindings(
        octokit,
        data.owner,
        data.repo,
        data.pull_number,
        botLogin,
      );
      const finding = open.find((f) => f.commentId === root.id);
      if (!finding) return;
      const { data: pull } = await octokit.rest.pulls.get({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pull_number,
      });
      if (pull.state !== "open") return;

      console.log(
        pc.cyan(
          `
[Worker] Answering ${reply.author}'s reply on ${data.owner}/${data.repo}#${data.pull_number} (finding ${finding.id})...`,
        ),
      );
      const ctx = await preparePRContext({
        octokit,
        token,
        owner: data.owner,
        repo: data.repo,
        pullNumber: data.pull_number,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        prInfo: { title: pull.title, body: pull.body },
      });
      cleanup = ctx.cleanup;

      const { config } = await loadConfig({
        overrides: { model: data.model || this.config.model },
      });
      const saved = this.sessionStore.load(data.owner, data.repo, data.pull_number);
      const result = await new PRAgent(config).answerReply({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pull_number,
        commit_id: pull.head.sha,
        rawDiff: ctx.rawDiff,
        repoDir: ctx.dir,
        mounts: ctx.mounts,
        finding,
        author: reply.author,
        reply: reply.body,
        session: saved?.model === config.model ? saved : undefined,
      });

      if (result.answer) {
        await octokit.rest.pulls.createReplyForReviewComment({
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pull_number,
          comment_id: root.id,
          body: result.answer,
        });
      }
      if (result.resolved) await resolveThread(octokit, finding.threadId);
      if (result.session) {
        this.sessionStore.save(data.owner, data.repo, data.pull_number, result.session);
      }
      console.log(
        pc.green(
          `[Worker] Answered reply (${result.resolved ? "finding resolved" : "finding stands"}, $${result.costUsd.toFixed(4)}).`,
        ),
      );
    } finally {
      await cleanup?.().catch(() => undefined);
      await this.queueManager
        .releasePRLock(data.owner, data.repo, data.pull_number, data.jobId)
        .catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
    this.subRedis.disconnect();
  }
}
