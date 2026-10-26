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
 * Whether `head` descends from `since`, i.e. the author pushed on top of the last reviewed commit.
 * A force-push or rebase (or a commit GitHub no longer has) means the whole PR is reviewed again.
 */
export async function isPushedOnTop(
  octokit: Octokit,
  owner: string,
  repo: string,
  since: string,
  head: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${since}...${head}`,
      per_page: 1,
    });
    return data.status === "ahead";
  } catch {
    return false;
  }
}

/** Merge base of the PR's base and head, the commit GitHub's PR diff starts from. */
export async function fetchMergeBase(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
    per_page: 1,
  });
  return data.merge_base_commit.sha;
}

/**
 * GitHub's diff of `from...to`, the fallback when it cannot be computed locally. Limited by GitHub
 * (it fails beyond 300 files), see docs/architecture/large-pr-context-rfc.md.
 */
export async function fetchCompareDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  from: string,
  to: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${from}...${to}`,
    mediaType: { format: "diff" },
  });
  return data as unknown as string;
}
