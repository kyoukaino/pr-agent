import * as http from "node:http";
import * as crypto from "node:crypto";
import pc from "picocolors";
import type { GitHubAppConfig } from "./config.js";
import type { PRReviewQueueManager } from "./queue.js";

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

export function createWebhookServer(
  config: GitHubAppConfig,
  queueManager: PRReviewQueueManager,
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
      if (eventName !== "pull_request") {
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

      const action = payload.action;
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
      await queueManager.addReviewJob({
        jobId,
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        installationId,
        model: config.model,
        createdAt: Date.now(),
      });

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
