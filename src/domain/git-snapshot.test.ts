import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { gitDiff, hasCommit, writeRevisionFiles } from "./git-snapshot.js";
import { parseGitDiff } from "./diff-parser.js";

describe("git snapshot", () => {
  let root: string;
  let repo: string;
  let base: string;
  let head: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-git-"));
    repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs"));
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "a\nb\nc\n");
    fs.writeFileSync(path.join(repo, "docs", "gone.md"), "old\n");
    fs.writeFileSync(path.join(repo, "src", "名 字.ts"), "keep\nthis\ncontent\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "a\nB\nc\nd\n");
    fs.rmSync(path.join(repo, "docs", "gone.md"));
    fs.writeFileSync(path.join(repo, "src", "new.ts"), "new\n");
    git("mv", "src/名 字.ts", "src/renamed.ts");
    git("add", "-A");
    git("commit", "--quiet", "-m", "head");
    head = git("rev-parse", "HEAD");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("diffs two revisions with verbatim paths and rename detection", async () => {
    const parsed = parseGitDiff(await gitDiff(repo, base, head));
    const byPath = new Map(parsed.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts")?.insertions).toBe(2);
    expect(byPath.get("docs/gone.md")?.type).toBe("delete");
    expect(byPath.get("src/new.ts")?.type).toBe("add");
    expect(byPath.get("src/renamed.ts")?.oldPath).toBe("src/名 字.ts");
  });

  it("writes the files of a revision without touching the repository", async () => {
    const out = path.join(root, "base");
    const written = await writeRevisionFiles(
      repo,
      base,
      ["src/a.ts", "docs/gone.md", "src/名 字.ts", "src/new.ts"],
      out,
    );
    expect(written).toBe(3); // src/new.ts does not exist at base
    expect(fs.readFileSync(path.join(out, "src", "a.ts"), "utf-8")).toBe("a\nb\nc\n");
    expect(fs.existsSync(path.join(out, "docs", "gone.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "src", "名 字.ts"))).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf-8")).toBe("a\nB\nc\nd\n");
  });

  it("knows which commits are present", async () => {
    expect(await hasCommit(repo, base)).toBe(true);
    expect(await hasCommit(repo, "0".repeat(40))).toBe(false);
  });
});
