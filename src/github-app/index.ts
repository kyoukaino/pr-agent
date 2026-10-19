import pc from "picocolors";
import { loadGitHubAppConfig } from "./config.js";
import { GitHubAppAuthManager } from "./auth.js";
import { PRReviewQueueManager } from "./queue.js";
import { PRReviewWorker } from "./worker.js";
import { createWebhookServer } from "./server.js";
import { startWebhookTunnelSync } from "./tunnel.js";
import { PRSessionStore } from "./session-store.js";
import { redeliverMissedDeliveries } from "./redelivery.js";

export * from "./config.js";
export * from "./auth.js";
export * from "./queue.js";
export * from "./worker.js";
export * from "./server.js";
export * from "./ci.js";
export * from "./tunnel.js";
export * from "./history.js";
export * from "./threads.js";
export * from "./session-store.js";
export * from "./redelivery.js";

/**
 * Boots the unified GitHub App server and BullMQ worker instance for private single-tenant deployment.
 */
export async function startGitHubApp(): Promise<void> {
  const config = loadGitHubAppConfig();
  console.log(pc.bold(pc.cyan("=== Starting PR-Agent GitHub App Service (Single-Tenant) ===")));
  console.log(`Port:  ${config.port}`);
  console.log(`Model: ${config.model}`);
  console.log(`Redis: ${config.redis.host}:${config.redis.port}`);

  const authManager = new GitHubAppAuthManager(config);
  const queueManager = new PRReviewQueueManager(config);
  const sessionStore = new PRSessionStore();
  const worker = new PRReviewWorker(config, authManager, queueManager, sessionStore);
  const server = createWebhookServer(config, queueManager, sessionStore);
  // Replay PR events GitHub failed to deliver while the service was down or the tunnel moved.
  const redeliver = () =>
    authManager
      .getAppOctokit()
      .then(redeliverMissedDeliveries)
      .catch((err: Error) => console.error(pc.yellow(`[Redelivery] failed: ${err.message}`)));
  const stopTunnelSync = config.tunnelMetricsUrl
    ? startWebhookTunnelSync(() => authManager.getAppOctokit(), config.tunnelMetricsUrl, redeliver)
    : undefined;

  server.listen(config.port, () => {
    console.log(pc.green(`✓ Webhook Server listening on http://0.0.0.0:${config.port}/webhook`));
    console.log(pc.green(`✓ Health Check ready at http://0.0.0.0:${config.port}/health`));
    console.log(
      pc.green(`✓ BullMQ Worker active (Concurrency: ${config.rateLimit.maxConcurrentReviews})`),
    );
    // With a quick tunnel, replay waits until the webhook points at the tunnel again.
    if (!stopTunnelSync) void redeliver();
  });

  const shutdown = async () => {
    console.log(pc.yellow("\nShutting down GitHub App gracefully..."));
    stopTunnelSync?.();
    server.close();
    await worker.close();
    await queueManager.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Allow direct execution via node/tsx
if (
  process.argv[1]?.endsWith("github-app/index.ts") ||
  process.argv[1]?.endsWith("github-app/index.js")
) {
  startGitHubApp().catch((err) => {
    console.error(pc.red(`Fatal startup error: ${err.message}`));
    process.exit(1);
  });
}
