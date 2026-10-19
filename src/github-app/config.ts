import { z } from "zod";

export const GitHubAppConfigSchema = z.object({
  appId: z.coerce.number().positive(),
  privateKey: z.string().min(10),
  webhookSecret: z.string().min(1),
  port: z.coerce.number().default(3000),
  redis: z
    .object({
      host: z.string().default("localhost"),
      port: z.coerce.number().default(6379),
      password: z.string().optional(),
    })
    .default({}),
  ciWait: z
    .object({
      /** How long a review waits for the head commit's CI to finish; 0 reviews immediately. */
      timeoutMs: z.coerce
        .number()
        .min(0)
        .default(15 * 60_000),
      /** How often CI is re-checked while waiting; also the delay before the first check. */
      pollIntervalMs: z.coerce.number().positive().default(60_000),
    })
    .default({}),
  rateLimit: z
    .object({
      maxConcurrentReviews: z.coerce.number().default(10),
      maxReviewsPerMinute: z.coerce.number().default(30),
    })
    .default({}),
  model: z.string().default("deepseek-flash"),
});

export type GitHubAppConfig = z.infer<typeof GitHubAppConfigSchema>;

export function loadGitHubAppConfig(): GitHubAppConfig {
  return GitHubAppConfigSchema.parse({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    port: process.env.PORT,
    redis: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
    },
    ciWait: {
      timeoutMs: process.env.CI_WAIT_TIMEOUT_MS,
      pollIntervalMs: process.env.CI_POLL_INTERVAL_MS,
    },
    rateLimit: {
      maxConcurrentReviews: process.env.MAX_CONCURRENT_REVIEWS,
      maxReviewsPerMinute: process.env.MAX_REVIEWS_PER_MINUTE,
    },
    model: process.env.PR_AGENT_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-flash",
  });
}
