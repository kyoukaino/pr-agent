import type { Octokit } from "@octokit/rest";
import type { PriorFinding } from "../domain/prompt.js";

/**
 * What earlier reviews of a PR by this App already covered, so a new push is reviewed
 * incrementally and findings are not posted twice.
 */
export interface ReviewHistory {
  /** Head commit of the most recent review by this App; undefined if it never reviewed the PR. */
  lastReviewedCommit?: string;
  /** Findings listed in this App's earlier review summaries, oldest first. */
  findings: PriorFinding[];
}

// One line per finding under "Key Findings Overview" (see ReviewPayloadAssembler):
// - **[P3]** `path/to/file.ts:12`: Title
const FINDING_LINE = /^- \*\*\[(P[0-4])\]\*\* `(.+):(\d+)`: (.+)$/gm;

/** Parses the findings listed in a review summary written by ReviewPayloadAssembler. */
export function parseSummaryFindings(body: string): PriorFinding[] {
  return [...body.matchAll(FINDING_LINE)].map((m) => ({
    severity: m[1],
    path: m[2],
    line: Number(m[3]),
    title: m[4].trim(),
  }));
}

export async function loadReviewHistory(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  botLogin: string,
): Promise<ReviewHistory> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const own = reviews.filter((r) => r.user?.login === botLogin);
  return {
    lastReviewedCommit: own.at(-1)?.commit_id ?? undefined,
    findings: own.flatMap((r) => parseSummaryFindings(r.body ?? "")),
  };
}

/**
 * Diff of the changes pushed since `since`, or undefined when `head` does not descend from it
 * (force-push or rebase), in which case the whole PR has to be reviewed again.
 */
export async function fetchIncrementalDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  since: string,
  head: string,
): Promise<string | undefined> {
  const basehead = `${since}...${head}`;
  try {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
      per_page: 1,
    });
    if (comparison.status !== "ahead") return undefined;
  } catch {
    return undefined; // the old commit is gone (force-push and garbage collection)
  }
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead,
    mediaType: { format: "diff" },
  });
  return data as unknown as string;
}
