import { execFileSync } from "node:child_process";

let cachedToken: string | null | undefined;

/** GITHUB_TOKEN / GH_TOKEN, falling back to the local `gh` CLI login. Anonymous if neither exists. */
export function githubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!cachedToken) {
    try {
      cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim() || null;
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken;
}

export async function githubApi<T>(
  apiPath: string,
  accept = "application/vnd.github+json",
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-agent-bench",
  };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${apiPath} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (accept.includes("json") ? await res.json() : await res.text()) as T;
}

export async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "pr-agent-bench" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

/** Parses https://github.com/{owner}/{name}/pull/{n}. */
export function parsePrUrl(url: string): { owner: string; name: string; number: number } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub PR URL: ${url}`);
  return { owner: m[1], name: m[2], number: Number(m[3]) };
}
