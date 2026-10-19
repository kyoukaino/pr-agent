import type { Octokit } from "@octokit/rest";
import pc from "picocolors";

/**
 * Keeps the App's webhook URL pointed at a Cloudflare Quick Tunnel.
 *
 * A quick tunnel (`cloudflared tunnel --url …`) gets a new random *.trycloudflare.com hostname on
 * every cloudflared restart. cloudflared reports the current hostname on its metrics server at
 * `/quicktunnel`, so the app reads it and updates its own webhook config whenever it changes.
 * Events sent while the URL was stale fail; they are replayed once the webhook reaches the tunnel
 * again (see redelivery.ts). A named tunnel with a fixed hostname avoids the gap altogether.
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

/**
 * Points the App's webhook at the tunnel's current hostname. Returns whether the webhook now
 * reaches the tunnel (undefined while cloudflared has no hostname yet) and whether it changed.
 */
async function syncOnce(
  appOctokit: Octokit,
  metricsUrl: string,
): Promise<{ changed: boolean } | undefined> {
  const hostname = await fetchQuickTunnelHostname(metricsUrl);
  if (!hostname) return undefined;
  const url = webhookUrlFor(hostname);
  const { data: current } = await appOctokit.rest.apps.getWebhookConfigForApp();
  if (current.url === url) return { changed: false };
  // Pass the body as `data`: a top-level `url` parameter would replace the request URL itself.
  await appOctokit.request("PATCH /app/hook/config", { data: { url, content_type: "json" } });
  console.log(pc.green(`✓ Webhook URL updated to ${url}`));
  return { changed: true };
}

/**
 * Starts syncing in the background; the returned function stops it. `onReachable` runs once the
 * webhook first points at the tunnel and again after every hostname change, i.e. whenever events
 * may have been missed.
 */
export function startWebhookTunnelSync(
  getAppOctokit: () => Promise<Octokit>,
  metricsUrl: string,
  onReachable?: () => Promise<unknown>,
): () => void {
  let reachedOnce = false;
  const tick = async () => {
    try {
      const res = await syncOnce(await getAppOctokit(), metricsUrl);
      if (res && (res.changed || !reachedOnce)) {
        reachedOnce = true;
        await onReachable?.();
      }
    } catch (err) {
      console.error(pc.yellow(`[Tunnel] Webhook URL sync failed: ${(err as Error).message}`));
    }
  };
  void tick();
  const timer = setInterval(tick, RECHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
