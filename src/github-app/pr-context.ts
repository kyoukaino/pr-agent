import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Octokit } from "@octokit/rest";
import { oldPathsOf, parseGitDiff } from "../domain/diff-parser.js";
import { gitDiff, writeRevisionFiles } from "../domain/git-snapshot.js";
import { BASE_MOUNT, PR_INFO_MOUNT } from "../domain/workspace.js";
import { checkoutPullRequest } from "./checkout.js";
import { fetchCompareDiff, fetchMergeBase } from "./history.js";

/** Everything a review or a reply answer reads besides the GitHub record. */
export interface PRContext {
  /** Checkout of the PR head. */
  dir: string;
  /** The PR diff (merge base → head). */
  rawDiff: string;
  /** Changes since `sinceCommit`; undefined when not asked for or not obtainable. */
  incrementalDiff?: string;
  /** Where the PR diff came from. */
  diffSource: "local" | "github" | "job";
  /** `@base` (merge-base files) and `@pr` (description, commits) when available. */
  mounts: Record<string, string>;
  cleanup: () => Promise<void>;
}

export interface PRContextParams {
  octokit: Octokit;
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  /** Last reviewed commit the head descends from: also produce the incremental diff. */
  sinceCommit?: string;
  /** PR diff provided with the job; computed otherwise. */
  rawDiff?: string;
  /** Written to `@pr` together with the commit messages. */
  prInfo?: { title: string; body?: string | null };
  signal?: AbortSignal;
}

/**
 * Checks out the PR head together with the merge base (and the last reviewed commit), then
 * computes the diffs locally, so a PR of any size can be reviewed: GitHub's diff API refuses more
 * than 300 files. GitHub's diff remains the fallback when a commit cannot be fetched.
 */
export async function preparePRContext(params: PRContextParams): Promise<PRContext> {
  const { octokit, owner, repo, headSha, sinceCommit, signal } = params;
  const mergeBase = await fetchMergeBase(octokit, owner, repo, params.baseSha, headSha).catch(
    () => undefined,
  );
  const checkout = await checkoutPullRequest({
    owner,
    repo,
    pullNumber: params.pullNumber,
    headSha,
    token: params.token,
    extraCommits: [mergeBase, sinceCommit],
    signal,
  });
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-ctx-"));
  const cleanup = async () => {
    fs.rmSync(ctxDir, { recursive: true, force: true });
    await checkout.cleanup();
  };

  try {
    const base = mergeBase && checkout.fetched.has(mergeBase) ? mergeBase : undefined;
    let rawDiff: string;
    let diffSource: PRContext["diffSource"];
    if (params.rawDiff) {
      rawDiff = params.rawDiff;
      diffSource = "job";
    } else if (base) {
      rawDiff = await gitDiff(checkout.dir, base, headSha, signal);
      diffSource = "local";
    } else {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: params.pullNumber,
        mediaType: { format: "diff" },
      });
      rawDiff = data as unknown as string;
      diffSource = "github";
    }

    // An incremental diff that cannot be obtained means a full review, not a failed one.
    let incrementalDiff: string | undefined;
    if (sinceCommit) {
      incrementalDiff = checkout.fetched.has(sinceCommit)
        ? await gitDiff(checkout.dir, sinceCommit, headSha, signal)
        : await fetchCompareDiff(octokit, owner, repo, sinceCommit, headSha).catch(() => undefined);
    }

    const mounts: Record<string, string> = {};
    if (base) {
      const baseDir = path.join(ctxDir, "base");
      const oldPaths = oldPathsOf(parseGitDiff(rawDiff).files);
      await writeRevisionFiles(checkout.dir, base, oldPaths, baseDir, signal);
      mounts[BASE_MOUNT] = baseDir;
    }
    if (params.prInfo) {
      mounts[PR_INFO_MOUNT] = await writePRInfo(params, path.join(ctxDir, "pr"));
    }

    return { dir: checkout.dir, rawDiff, incrementalDiff, diffSource, mounts, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** `description.md` and `commits.md`; commit messages are optional context. */
async function writePRInfo(params: PRContextParams, dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const { title, body } = params.prInfo!;
  fs.writeFileSync(path.join(dir, "description.md"), `# ${title}\n\n${body ?? ""}\n`, "utf-8");
  try {
    const commits = await params.octokit.paginate(params.octokit.rest.pulls.listCommits, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100,
    });
    const md = commits
      .map((c) => `## ${c.sha.slice(0, 7)} ${c.commit.author?.name ?? ""}\n\n${c.commit.message}\n`)
      .join("\n");
    fs.writeFileSync(path.join(dir, "commits.md"), `# Commits\n\n${md}`, "utf-8");
  } catch {
    // the description alone still helps
  }
  return dir;
}
