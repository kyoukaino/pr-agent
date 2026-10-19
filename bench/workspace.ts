import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { githubApi } from "./github.js";
import { CACHE_DIR } from "./datasets.js";
import type { BenchInstance } from "./types.js";

const execFileAsync = promisify(execFile);

export type RepoMode = "checkout" | "diff-only";

export interface PreparedWorkspace {
  baseCommit: string;
  headCommit: string;
  rawDiff: string;
  prTitle: string;
  prBody: string;
  /** Directory the agent's read_file / grep_code tools operate on. */
  repoDir: string;
  cleanup: () => Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf-8",
  });
  return stdout;
}

// Serialize git operations per repository: concurrent fetch/worktree commands on one repo race on its locks.
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => undefined),
  );
  return next;
}

async function ensureRepo(repo: string): Promise<string> {
  const dir = path.join(CACHE_DIR, "repos", repo.replace("/", "__"));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, ["init", "--quiet"]);
    await git(dir, ["remote", "add", "origin", `https://github.com/${repo}.git`]);
    for (const [k, v] of [
      ["core.longpaths", "true"],
      ["core.autocrlf", "false"],
      ["core.symlinks", "false"],
      ["gc.auto", "0"],
      ["advice.detachedHead", "false"],
    ]) {
      await git(dir, ["config", k, v]);
    }
  }
  return dir;
}

async function hasCommit(dir: string, sha: string): Promise<boolean> {
  try {
    await git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Shallow-fetches `ref` (a commit sha or refs/pull/N/head) and checks it out into a throwaway worktree. */
async function checkoutWorktree(repo: string, ref: string, sha: string, instanceId: string) {
  const repoDir = await ensureRepo(repo);
  const workDir = path.join(CACHE_DIR, "work", instanceId.replace(/[^\w.-]/g, "_"));

  await withRepoLock(repo, async () => {
    if (!(await hasCommit(repoDir, sha))) {
      await git(repoDir, ["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", ref]);
    }
    if (fs.existsSync(workDir)) {
      await git(repoDir, ["worktree", "remove", "--force", workDir]).catch(() => undefined);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    await git(repoDir, ["worktree", "prune"]);
    await git(repoDir, ["worktree", "add", "--quiet", "--detach", "--force", workDir, sha]);
  });

  return {
    workDir,
    cleanup: () =>
      withRepoLock(repo, async () => {
        await git(repoDir, ["worktree", "remove", "--force", workDir]).catch(() => undefined);
        fs.rmSync(workDir, { recursive: true, force: true });
      }),
  };
}

interface PullInfo {
  title: string;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
}

/**
 * Resolves commits, fetches the PR diff and (in checkout mode) materializes the head revision.
 *
 * The diff is always GitHub's three-dot diff (merge-base...head), i.e. exactly the PR's change.
 * AACR's source commit is often a later target-branch tip rather than an ancestor of the head,
 * so a two-dot `git diff base head` would mix in hundreds of unrelated upstream commits.
 */
export async function prepareWorkspace(
  instance: BenchInstance,
  mode: RepoMode,
): Promise<PreparedWorkspace> {
  let baseCommit = instance.baseCommit;
  let headCommit = instance.headCommit;
  let rawDiff: string;
  let headRef: string;

  const pull = await githubApi<PullInfo>(`/repos/${instance.repo}/pulls/${instance.prNumber}`);
  const prTitle = pull.title;
  const prBody = pull.body ?? "";

  if (instance.dataset === "martian") {
    baseCommit = pull.base.sha;
    headCommit = pull.head.sha;
    headRef = `refs/pull/${instance.prNumber}/head`;
    rawDiff = await githubApi<string>(
      `/repos/${instance.repo}/pulls/${instance.prNumber}`,
      "application/vnd.github.diff",
    );
  } else {
    if (!baseCommit || !headCommit) throw new Error(`${instance.id}: missing base/head commit`);
    headRef = headCommit;
    rawDiff = await githubApi<string>(
      `/repos/${instance.repo}/compare/${baseCommit}...${headCommit}`,
      "application/vnd.github.diff",
    );
  }

  if (mode === "diff-only") {
    // An empty directory: context tools honestly report "not found" instead of reading an unrelated tree.
    const emptyDir = path.join(CACHE_DIR, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    return {
      baseCommit,
      headCommit,
      rawDiff,
      prTitle,
      prBody,
      repoDir: emptyDir,
      cleanup: async () => {},
    };
  }

  const { workDir, cleanup } = await checkoutWorktree(
    instance.repo,
    headRef,
    headCommit,
    instance.id,
  );
  return { baseCommit, headCommit, rawDiff, prTitle, prBody, repoDir: workDir, cleanup };
}
