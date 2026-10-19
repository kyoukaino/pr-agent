import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import pc from "picocolors";
import type { GitHubAppConfig } from "./config.js";

/**
 * Keeps the App's webhook URL pointed at a Cloudflare Quick Tunnel.
 *
 * A quick tunnel (`cloudflared tunnel --url …`) gets a new random *.trycloudflare.com hostname on
 * every cloudflared restart. cloudflared reports the current hostname on its metrics server at
 * `/quicktunnel`, so the app reads it and updates its own webhook config whenever it changes.
 * Events delivered while the URL is stale are lost; a named tunnel with a fixed hostname avoids that.
 */

const RECHECK_INTERVAL_MS = 60_000;

/** Reads the current quick-tunnel hostname; undefined while cloudflared has not connected yet. */
export async function fetchQuickTunnelHostname(metricsUrl: string): Promise<string | undefined> {
  const res = await fetch(new URL("/quicktunnel", metricsUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return undefined;
  const { hostname } = (await res.json()) as { hostname?: string };
  return hostname || undefined;
}

export function webhookUrlFor(hostname: string): string {
  return `https://${hostname}/webhook`;
}

type AppAuth = ReturnType<typeof createAppAuth>;

/** Updates the App's webhook URL if it differs; returns whether it changed. */
async function syncOnce(auth: AppAuth, metricsUrl: string): Promise<boolean> {
  const hostname = await fetchQuickTunnelHostname(metricsUrl);
  if (!hostname) return false;
  const url = webhookUrlFor(hostname);
  // The webhook config endpoints take the App's JWT; auth-app's request hook does not route them
  // to it, so mint one explicitly (it expires after 10 minutes, hence per sync).
  const { token } = await auth({ type: "app" });
  const appOctokit = new Octokit({ auth: token });
  const { data: current } = await appOctokit.rest.apps.getWebhookConfigForApp();
  if (current.url === url) return false;
  // Pass the body as `data`: a top-level `url` parameter would replace the request URL itself.
  await appOctokit.request("PATCH /app/hook/config", { data: { url, content_type: "json" } });
  console.log(pc.green(`✓ Webhook URL updated to ${url}`));
  return true;
}

/** Starts syncing in the background; the returned function stops it. */
export function startWebhookTunnelSync(config: GitHubAppConfig, metricsUrl: string): () => void {
  const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  const tick = () =>
    syncOnce(auth, metricsUrl).catch((err: Error) => {
      console.error(pc.yellow(`[Tunnel] Webhook URL sync failed: ${err.message}`));
    });
  void tick();
  const timer = setInterval(tick, RECHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
