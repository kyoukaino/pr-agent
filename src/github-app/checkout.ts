import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PRCheckout {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Materializes the PR head revision in a throwaway directory so the agent's read_file / grep_code
 * tools see the code under review (not the worker's own filesystem).
 *
 * Shallow-fetches refs/pull/{n}/head, which also works for PRs opened from forks. The installation
 * token is passed as an HTTP header through GIT_CONFIG_* environment variables, so it never appears
 * in the remote URL, the process arguments or .git/config.
 */
export async function checkoutPullRequest(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  token: string;
  signal?: AbortSignal;
}): Promise<PRCheckout> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-"));
  const basic = Buffer.from(`x-access-token:${params.token}`).toString("base64");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  const git = (args: string[]) =>
    execFileAsync("git", args, {
      cwd: dir,
      env,
      signal: params.signal,
      maxBuffer: 64 * 1024 * 1024,
    });

  const cleanup = async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await git(["init", "--quiet"]);
    await git(["config", "core.symlinks", "false"]); // never follow links planted by the PR
    await git([
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      `https://github.com/${params.owner}/${params.repo}.git`,
      `refs/pull/${params.pullNumber}/head`,
    ]);
    const fetched = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
    if (fetched !== params.headSha) {
      // The PR moved on since the webhook fired; review exactly the commit we were asked about.
      await git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        `https://github.com/${params.owner}/${params.repo}.git`,
        params.headSha,
      ]);
    }
    await git(["checkout", "--quiet", "--detach", params.headSha]);
    return { dir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
