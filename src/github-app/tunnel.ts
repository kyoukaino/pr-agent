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

/** Updates the App's webhook URL if it differs; returns whether it changed. */
async function syncOnce(appOctokit: Octokit, metricsUrl: string): Promise<boolean> {
  const hostname = await fetchQuickTunnelHostname(metricsUrl);
  if (!hostname) return false;
  const url = webhookUrlFor(hostname);
  const { data: current } = await appOctokit.rest.apps.getWebhookConfigForApp();
  if (current.url === url) return false;
  await appOctokit.rest.apps.updateWebhookConfigForApp({ url, content_type: "json" });
  console.log(pc.green(`✓ Webhook URL updated to ${url}`));
  return true;
}

/** Starts syncing in the background; the returned function stops it. */
export function startWebhookTunnelSync(config: GitHubAppConfig, metricsUrl: string): () => void {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
  });
  const tick = () =>
    syncOnce(appOctokit, metricsUrl).catch((err: Error) => {
      console.error(pc.yellow(`[Tunnel] Webhook URL sync failed: ${err.message}`));
    });
  void tick();
  const timer = setInterval(tick, RECHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
