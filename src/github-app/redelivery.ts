import type { Octokit } from "@octokit/rest";
import pc from "picocolors";

/** GitHub keeps deliveries for redelivery for 3 days; older misses are not worth replaying. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface HookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number;
  event: string;
}

/**
 * Deliveries to replay: pull_request events within the lookback window that never reached the
 * service (no attempt for the same guid succeeded), one per guid (its latest attempt).
 */
export function selectMissedDeliveries(deliveries: HookDelivery[], now: number): HookDelivery[] {
  const byGuid = new Map<string, HookDelivery[]>();
  for (const d of deliveries) byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);
  const missed: HookDelivery[] = [];
  for (const attempts of byGuid.values()) {
    const latest = attempts.reduce((a, b) => (a.delivered_at > b.delivered_at ? a : b));
    const ok = attempts.some((d) => d.status_code >= 200 && d.status_code < 300);
    const recent = now - Date.parse(latest.delivered_at) < LOOKBACK_MS;
    if (!ok && recent && latest.event === "pull_request") missed.push(latest);
  }
  return missed.sort((a, b) => a.delivered_at.localeCompare(b.delivered_at));
}

/**
 * Replays the PR events GitHub failed to deliver (service down, or a quick tunnel that changed its
 * hostname). The worker skips commits that were already reviewed, so a replay never doubles a review.
 */
export async function redeliverMissedDeliveries(appOctokit: Octokit): Promise<number> {
  const { data } = await appOctokit.request("GET /app/hook/deliveries", { per_page: 100 });
  const missed = selectMissedDeliveries(data as HookDelivery[], Date.now());
  for (const d of missed) {
    await appOctokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
      delivery_id: d.id,
    });
  }
  if (missed.length > 0) {
    console.log(pc.green(`✓ Requested redelivery of ${missed.length} missed webhook event(s)`));
  }
  return missed.length;
}
