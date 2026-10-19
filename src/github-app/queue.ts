import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { GitHubAppConfig } from "./config.js";

export interface PRReviewJobData {
  jobId: string;
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  installationId: number;
  rawDiff?: string;
  model: string;
  createdAt: number;
}

const ACTIVE_JOB_TTL_SECONDS = 6 * 60 * 60;

export class PRReviewQueueManager {
  public readonly queue: Queue<PRReviewJobData, void, "review_pr">;
  public readonly redis: Redis;
  public readonly subRedis: Redis;

  constructor(config: GitHubAppConfig) {
    const redisOptions = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null, // Required by BullMQ
    };

    this.redis = new Redis(redisOptions);
    this.subRedis = new Redis(redisOptions);

    // Rate limiting lives on the Worker (BullMQ has no queue-level limiter option).
    this.queue = new Queue<PRReviewJobData, void, "review_pr">("pr-agent-reviews", {
      connection: this.redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  /**
   * Pushes a review job into the BullMQ queue.
   */
  public async addReviewJob(data: PRReviewJobData): Promise<void> {
    await this.queue.add("review_pr", data, {
      jobId: data.jobId,
      priority: data.model.includes("flash") ? 1 : 2, // flash gets higher priority
    });
  }

  /**
   * Records active job for a PR in Redis hash to track ongoing reviews.
   */
  public async setActiveJob(
    owner: string,
    repo: string,
    prNumber: number,
    jobId: string,
  ): Promise<string | null> {
    const key = `pr:active:${owner}/${repo}:${prNumber}`;
    // Atomically swap the marker; the TTL only guards against crashed workers, so it must outlive
    // queue wait + review time (otherwise a long-queued job would look superseded).
    const previousJobId = await this.redis.set(key, jobId, "EX", ACTIVE_JOB_TTL_SECONDS, "GET");
    return previousJobId;
  }

  public async getActiveJob(owner: string, repo: string, prNumber: number): Promise<string | null> {
    return this.redis.get(`pr:active:${owner}/${repo}:${prNumber}`);
  }

  /**
   * Removes active job tracking upon completion.
   */
  public async clearActiveJob(
    owner: string,
    repo: string,
    prNumber: number,
    jobId: string,
  ): Promise<void> {
    const key = `pr:active:${owner}/${repo}:${prNumber}`;
    // Compare-and-delete in one step so a newer job's marker is never removed.
    await this.redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      1,
      key,
      jobId,
    );
  }

  /**
   * Broadcasts cancellation signal via Redis Pub/Sub for stale PR reviews.
   */
  public async broadcastCancelJob(jobId: string, reason: string): Promise<void> {
    await this.redis.publish("pr-agent:cancel", JSON.stringify({ jobId, reason }));
  }

  public async close(): Promise<void> {
    await this.queue.close();
    this.redis.disconnect();
    this.subRedis.disconnect();
  }
}
