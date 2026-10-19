import pc from "picocolors";
import { loadGitHubAppConfig } from "./config.js";
import { GitHubAppAuthManager } from "./auth.js";
import { PRReviewQueueManager } from "./queue.js";
import { PRReviewWorker } from "./worker.js";
import { createWebhookServer } from "./server.js";

export * from "./config.js";
export * from "./auth.js";
export * from "./queue.js";
export * from "./worker.js";
export * from "./server.js";

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
  const worker = new PRReviewWorker(config, authManager, queueManager);
  const server = createWebhookServer(config, queueManager);

  server.listen(config.port, () => {
    console.log(pc.green(`✓ Webhook Server listening on http://0.0.0.0:${config.port}/webhook`));
    console.log(pc.green(`✓ Health Check ready at http://0.0.0.0:${config.port}/health`));
    console.log(
      pc.green(`✓ BullMQ Worker active (Concurrency: ${config.rateLimit.maxConcurrentReviews})`),
    );
  });

  const shutdown = async () => {
    console.log(pc.yellow("\nShutting down GitHub App gracefully..."));
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
