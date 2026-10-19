import { UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import pc from "picocolors";
import { PRAgent } from "../index.js";
import { loadConfig } from "../config/loader.js";
import { TaskCancellationTree } from "../runtime/cancellation.js";
import type { GitHubAppConfig } from "./config.js";
import type { PRReviewJobData, PRReviewQueueManager } from "./queue.js";
import type { GitHubAppAuthManager } from "./auth.js";
import { checkoutPullRequest } from "./checkout.js";

export class PRReviewWorker {
  private worker: Worker<PRReviewJobData>;
  private subRedis: Redis;
  private activeTasks: Map<string, TaskCancellationTree> = new Map();

  constructor(
    private config: GitHubAppConfig,
    private authManager: GitHubAppAuthManager,
    private queueManager: PRReviewQueueManager,
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
      async (job: Job<PRReviewJobData>) => {
        return this.processJob(job);
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

  private async processJob(job: Job<PRReviewJobData>): Promise<void> {
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

    console.log(
      pc.cyan(
        `\n[Worker] Processing PR Review for ${data.owner}/${data.repo}#${data.pull_number} (Commit: ${data.commit_id.slice(0, 7)})...`,
      ),
    );

    const cancellationTree = new TaskCancellationTree();
    this.activeTasks.set(data.jobId, cancellationTree);
    let cleanup: (() => Promise<void>) | undefined;
    // The active marker is cleared only when no retry will follow; a retry must still see itself as current.
    let finished = false;

    try {
      // 1. Authenticate with GitHub App Installation Token
      const { octokit, token } = await this.authManager.getInstallationClient(data.installationId);

      // 2. Fetch raw diff from GitHub API if not pre-cached
      let rawDiff = data.rawDiff;
      if (!rawDiff) {
        const diffResponse = await octokit.rest.pulls.get({
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pull_number,
          mediaType: { format: "diff" },
        });
        rawDiff = diffResponse.data as unknown as string;
      }

      if (!rawDiff || !rawDiff.trim()) {
        console.log(pc.yellow(`[Worker] No diff content for PR #${data.pull_number}. Skipping.`));
        finished = true;
        return;
      }

      // 3. Check out the PR head so context tools read the code under review.
      const checkout = await checkoutPullRequest({
        owner: data.owner,
        repo: data.repo,
        pullNumber: data.pull_number,
        headSha: data.commit_id,
        token,
        signal: cancellationTree.signal,
      });
      cleanup = checkout.cleanup;

      // 4. Instantiate PR-Agent with the project configuration (rules, budget, policy)
      const { config } = await loadConfig({
        overrides: { model: data.model || this.config.model },
      });
      const agent = new PRAgent(config);

      // 5. Run autonomous review; a cancel broadcast aborts it mid-flight
      const reviewPayload = await agent.reviewPR({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pull_number,
        commit_id: data.commit_id,
        rawDiff,
        repoDir: checkout.dir,
        signal: cancellationTree.signal,
      });

      if (cancellationTree.isAborted || !(await isCurrent())) {
        console.log(
          pc.yellow(`[Worker] Review completed but job was superseded. Discarding review.`),
        );
        finished = true;
        return;
      }

      // 6. Post review payload directly to GitHub
      console.log(
        pc.green(
          `[Worker] Posting review to GitHub (${reviewPayload.event}, ${reviewPayload.comments.length} comments)...`,
        ),
      );
      await octokit.rest.pulls.createReview(reviewPayload);
      finished = true;
    } catch (err) {
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
      if (finished) {
        await this.queueManager
          .clearActiveJob(data.owner, data.repo, data.pull_number, data.jobId)
          .catch(() => undefined);
      }
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
    this.subRedis.disconnect();
  }
}
