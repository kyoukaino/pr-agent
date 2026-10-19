import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { ToolDispatcher, TOOL_OUTPUT_LIMITS } from "./tools.js";
import type { EmittedComment } from "./github-types.js";

describe("ToolDispatcher", () => {
  let root: string;
  let repo: string;
  const emitted: EmittedComment[] = [];
  let tools: ToolDispatcher;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-tools-"));
    repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "secret.env"), "API_KEY=do-not-leak\n");
    fs.writeFileSync(
      path.join(repo, "src", "app.ts"),
      "export const needle = 1;\nconst other = 2;\n",
    );
    // A minified bundle with one enormous line (the shape that used to flood the context).
    fs.writeFileSync(
      path.join(repo, "src", "bundle.min.js"),
      `var needle=1;${"x".repeat(300_000)}\n`,
    );
    fs.writeFileSync(path.join(repo, "src", "wide.ts"), `const needle = "${"y".repeat(5_000)}";\n`);
    tools = new ToolDispatcher({
      repoDir: repo,
      changedPaths: ["src/app.ts"],
      onCommentEmitted: (c) => emitted.push(c),
    });
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("refuses to read files outside the repository", async () => {
    const res = await tools.execute("read_file", JSON.stringify({ path: "../secret.env" }));
    expect(res.failed).toBe(true);
    expect(res.result).toContain("outside the repository");
    expect(res.result).not.toContain("do-not-leak");

    const abs = await tools.execute(
      "read_file",
      JSON.stringify({ path: path.join(root, "secret.env") }),
    );
    expect(abs.failed).toBe(true);
  });

  it("reads numbered lines inside the repository", async () => {
    const res = await tools.execute("read_file", JSON.stringify({ path: "src/app.ts" }));
    expect(res.failed).toBeUndefined();
    expect(res.result).toContain("1 | export const needle = 1;");
  });

  it("greps with ripgrep, skipping minified files and clipping wide lines", async () => {
    const res = await tools.execute("grep_code", JSON.stringify({ pattern: "needle" }));
    expect(res.failed).toBeUndefined();
    expect(res.result).toContain("src/app.ts:1:");
    expect(res.result).not.toContain("bundle.min.js");
    expect(res.result.length).toBeLessThan(TOOL_OUTPUT_LIMITS.maxOutputChars);
    const wide = res.result.split("\n").find((l) => l.startsWith("src/wide.ts"));
    expect(wide).toBeDefined();
    expect(wide!.length).toBeLessThan(1_000);
  });

  it("reports an invalid regex as a failed call (so the failure streak can trip)", async () => {
    const res = await tools.execute("grep_code", JSON.stringify({ pattern: "(" }));
    expect(res.failed).toBe(true);
  });

  it("only accepts comments on files changed by the PR", async () => {
    const ok = await tools.execute(
      "code_comment",
      JSON.stringify({
        path: "src/app.ts",
        line: 1,
        severity: "P2",
        category: "bug",
        title: "t",
        body: "b",
      }),
    );
    expect(ok.failed).toBeUndefined();
    expect(emitted).toHaveLength(1);

    const rejected = await tools.execute(
      "code_comment",
      JSON.stringify({
        path: "src/wide.ts",
        line: 1,
        severity: "P2",
        category: "bug",
        title: "t",
        body: "b",
      }),
    );
    expect(rejected.failed).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it("signals task_done separately from tool failures", async () => {
    const done = await tools.execute("task_done", JSON.stringify({ state: "DONE" }));
    expect(done).toMatchObject({ done: true, completed: true });
    const failed = await tools.execute("task_done", JSON.stringify({ state: "FAILED" }));
    expect(failed).toMatchObject({ done: true, completed: false });
    expect(failed.failed).toBeUndefined();
  });
});
