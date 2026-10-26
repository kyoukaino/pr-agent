import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Local git operations that turn a checkout into review input: the PR diff (no size limit, unlike
 * GitHub's diff API) and the files of an earlier revision. Global and system git configuration
 * are ignored, and every option that shapes the diff is passed explicitly, so the output matches
 * GitHub's PR diff (merge base → head, rename detection, 3 lines of context) whatever the host has
 * configured.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  // "/dev/null" rather than os.devNull: Git for Windows maps it, but rejects the Windows device path.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(repoDir: string, args: string[], signal?: AbortSignal, env = GIT_ENV) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoDir,
    env,
    signal,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout;
}

/** Whether the repository has the commit object (a shallow fetch may have failed). */
export async function hasCommit(repoDir: string, rev: string): Promise<boolean> {
  try {
    await git(repoDir, ["cat-file", "-e", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// GitHub assigns git's built-in html diff driver, which only changes the context text after a
// hunk header (`@@ … @@ <h2>Title</h2>`); the repository's own .gitattributes still apply on top.
let attributesFile: string | undefined;
function diffAttributesFile(): string {
  if (!attributesFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-gitattr-"));
    attributesFile = path.join(dir, "attributes");
    fs.writeFileSync(attributesFile, "*.html diff=html\n*.htm diff=html\n");
  }
  return attributesFile;
}

/**
 * Unified diff from `from` to `to`, or to the working tree when `to` is omitted. Paths are kept
 * verbatim (no octal quoting), as review comments address them.
 */
export function gitDiff(
  repoDir: string,
  from: string,
  to?: string,
  signal?: AbortSignal,
): Promise<string> {
  return git(
    repoDir,
    [
      "-c",
      "core.quotePath=false",
      "-c",
      `core.attributesFile=${diffAttributesFile()}`,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      from,
      ...(to ? [to] : []),
      "--",
    ],
    signal,
  );
}

/**
 * Writes the given files as they are at `rev` under `outDir` (paths missing at `rev` are skipped).
 * Uses a throwaway index, so the repository's own index and working tree are never touched;
 * symlinks are written as plain files holding their target.
 */
export async function writeRevisionFiles(
  repoDir: string,
  rev: string,
  paths: string[],
  outDir: string,
  signal?: AbortSignal,
): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true });
  if (paths.length === 0) return 0;
  // Chunked to stay under command-line length limits (Windows: 32k characters).
  const present: string[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    const listed = await git(
      repoDir,
      [
        "-c",
        "core.quotePath=false",
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        rev,
        "--",
        ...paths.slice(i, i + 200),
      ],
      signal,
      { ...GIT_ENV, GIT_LITERAL_PATHSPECS: "1" },
    );
    present.push(...listed.split("\0").filter(Boolean));
  }
  if (present.length === 0) return 0;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-rev-"));
  try {
    const pathspec = path.join(scratch, "pathspec");
    fs.writeFileSync(pathspec, present.join("\0"));
    await git(
      repoDir,
      [
        "-c",
        "core.symlinks=false",
        `--work-tree=${path.resolve(outDir)}`,
        "checkout",
        rev,
        `--pathspec-from-file=${pathspec}`,
        "--pathspec-file-nul",
      ],
      signal,
      { ...GIT_ENV, GIT_INDEX_FILE: path.join(scratch, "index"), GIT_LITERAL_PATHSPECS: "1" },
    );
    return present.length;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
