import * as http from "node:http";
import * as crypto from "node:crypto";
import pc from "picocolors";
import type { GitHubAppConfig } from "./config.js";
import type { PRReviewJobData, PRReviewQueueManager } from "./queue.js";
import type { PRSessionStore } from "./session-store.js";

// GitHub caps webhook payloads at 25 MB.
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

/** Constant-time check of X-Hub-Signature-256; length mismatch is a plain rejection, not an exception. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(
    `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const received = Buffer.from(signature);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/** Participants whose replies the agent answers; others could spend the LLM budget on any public PR. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * A job answering a human's reply in a review thread, or undefined for comments to ignore: new
 * threads, bot comments (the App's own replies included) and people outside the PR. Whether the
 * thread is one of this App's findings is checked by the worker.
 */
export function replyJobFor(
  payload: Record<string, any>,
  model: string,
): PRReviewJobData | undefined {
  const comment = payload.comment;
  const pr = payload.pull_request;
  if (payload.action !== "created" || !comment?.in_reply_to_id || !pr) return undefined;
  if (comment.user?.type === "Bot") return undefined;
  const trusted =
    TRUSTED_ASSOCIATIONS.has(comment.author_association) || comment.user?.login === pr.user?.login;
  if (!trusted || !payload.installation?.id) return undefined;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  return {
    jobId: `reply_${owner}_${repo}_pr${pr.number}_${comment.id}`,
    owner,
    repo,
    pull_number: pr.number,
    commit_id: pr.head.sha,
    installationId: payload.installation.id,
    model,
    createdAt: Date.now(),
    ciDeadline: 0,
    reply: {
      commentId: comment.id,
      rootCommentId: comment.in_reply_to_id,
      author: comment.user.login,
      body: String(comment.body ?? ""),
    },
  };
}

export function createWebhookServer(
  config: GitHubAppConfig,
  queueManager: PRReviewQueueManager,
  sessionStore?: PRSessionStore,
): http.Server {
  return http.createServer(async (req, res) => {
    // 1. Health check endpoint
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
      return;
    }

    // 2. Only process POST /webhook
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // Read incoming body (bounded)
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("error", () => res.destroy());
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      handle(Buffer.concat(chunks)).catch((err) => {
        console.error(pc.red(`[Server] Webhook handling failed: ${(err as Error).message}`));
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal error");
        }
      });
    });

    const handle = async (bodyBuffer: Buffer) => {
      const rawBody = bodyBuffer.toString("utf-8");

      // Verify HMAC-SHA256 signature over the exact bytes received
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Missing X-Hub-Signature-256");
        return;
      }
      if (!verifyWebhookSignature(config.webhookSecret, bodyBuffer, signature)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Invalid webhook signature");
        return;
      }

      const eventName = req.headers["x-github-event"] as string;
      if (eventName !== "pull_request" && eventName !== "pull_request_review_comment") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `Ignored event: ${eventName}` }));
        return;
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Malformed JSON");
        return;
      }

      if (eventName === "pull_request_review_comment") {
        const job = replyJobFor(payload, config.model);
        if (job) {
          await queueManager.addReviewJob(job);
          console.log(pc.green(`[Server] Enqueued reply job: ${job.jobId}`));
        }
        res.writeHead(job ? 202 : 200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            job ? { status: "accepted", jobId: job.jobId } : { message: "Ignored comment" },
          ),
        );
        return;
      }

      const action = payload.action;
      // A closed (or merged) PR's review conversations are no longer needed.
      if (action === "closed" && payload.repository && payload.pull_request) {
        sessionStore?.delete(
          payload.repository.owner.login,
          payload.repository.name,
          payload.pull_request.number,
        );
      }
      if (action !== "opened" && action !== "synchronize" && action !== "reopened") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `Ignored PR action: ${action}` }));
        return;
      }

      const owner = payload.repository?.owner?.login;
      const repo = payload.repository?.name;
      const pullNumber = payload.pull_request?.number;
      const commitId = payload.pull_request?.head?.sha;
      const installationId = payload.installation?.id;

      if (!owner || !repo || !pullNumber || !commitId || !installationId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing required payload fields");
        return;
      }

      const jobId = `job_${owner}_${repo}_pr${pullNumber}_${commitId.slice(0, 7)}_${Date.now()}`;

      // Check and cancel previous stale review if ongoing
      const previousJobId = await queueManager.setActiveJob(owner, repo, pullNumber, jobId);
      if (previousJobId) {
        console.log(
          pc.yellow(
            `\n[Server] Detected newer commit on ${owner}/${repo}#${pullNumber}. Canceling stale job: ${previousJobId}`,
          ),
        );
        await queueManager.broadcastCancelJob(previousJobId, "Superseded by newer commit");
      }

      // Push review job into BullMQ
      // Reviews wait for CI (see worker). The first check is delayed one poll interval so the
      // commit's CI has time to register its checks; with waiting disabled the job runs at once.
      const now = Date.now();
      const waitForCi = config.ciWait.timeoutMs > 0;
      await queueManager.addReviewJob(
        {
          jobId,
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: commitId,
          installationId,
          model: config.model,
          createdAt: now,
          ciDeadline: now + config.ciWait.timeoutMs,
        },
        waitForCi ? config.ciWait.pollIntervalMs : 0,
      );

      console.log(
        pc.green(
          `[Server] Enqueued PR review job: ${jobId} for ${owner}/${repo}#${pullNumber} (Commit: ${commitId.slice(0, 7)})`,
        ),
      );

      // Respond 202 Accepted immediately to GitHub (< 30ms)
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "accepted",
          jobId,
          pull_request: `${owner}/${repo}#${pullNumber}`,
          commit: commitId,
        }),
      );
    };
  });
}
