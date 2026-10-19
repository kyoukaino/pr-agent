import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { GitHubAppConfig } from "./config.js";

/** A PR participant's reply in the thread of a finding this App posted. */
export interface AuthorReply {
  commentId: number;
  /** First comment of the thread: the finding. */
  rootCommentId: number;
  author: string;
  body: string;
}

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
  /** Until when (epoch ms) the review waits for the head commit's CI to finish. */
  ciDeadline: number;
  /** Set for a job that answers an author's reply instead of reviewing a commit. */
  reply?: AuthorReply;
}

const ACTIVE_JOB_TTL_SECONDS = 6 * 60 * 60;
/** Outlives the longest job (30 min review budget plus checkout and posting); guards crashed workers. */
const PR_LOCK_TTL_SECONDS = 60 * 60;

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
  public async addReviewJob(data: PRReviewJobData, delayMs = 0): Promise<void> {
    await this.queue.add("review_pr", data, {
      jobId: data.jobId,
      delay: delayMs,
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
   * Takes the PR's lock for `holder`: reviews and reply answers of one PR share its review
   * conversations, so they run one at a time. Re-entrant for the same holder (job retries).
   */
  public async acquirePRLock(
    owner: string,
    repo: string,
    prNumber: number,
    holder: string,
  ): Promise<boolean> {
    const acquired = await this.redis.eval(
      `local v = redis.call("GET", KEYS[1])
       if v == false or v == ARGV[1] then
         redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
         return 1
       end
       return 0`,
      1,
      `pr:lock:${owner}/${repo}:${prNumber}`,
      holder,
      PR_LOCK_TTL_SECONDS,
    );
    return acquired === 1;
  }

  public async releasePRLock(
    owner: string,
    repo: string,
    prNumber: number,
    holder: string,
  ): Promise<void> {
    await this.redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      1,
      `pr:lock:${owner}/${repo}:${prNumber}`,
      holder,
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
