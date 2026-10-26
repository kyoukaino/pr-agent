import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { oldPathsOf, parseGitDiff } from "./diff-parser.js";
import { CoverageTracker } from "./coverage.js";
import {
  BASE_MOUNT,
  CI_LOGS_MOUNT,
  PR_DIFF_MOUNT,
  describeChangedFiles,
  describeMounts,
  writeDiffMount,
} from "./workspace.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@ first
 one
+two
 three
@@ -20,2 +21,2 @@ second
-old
+new
 tail
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
--- a/docs/old.md
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-a
+b
`;

describe("diff mount", () => {
  let root: string;
  const files = parseGitDiff(DIFF).files;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-ws-"));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("records each hunk's line span within the promptDiff", () => {
    const a = files[0];
    const lines = a.promptDiff.split("\n");
    for (const h of a.hunkRanges) {
      expect(lines[h.promptStart - 1]).toBe(h.header);
    }
    expect(a.hunkRanges.map((h) => [h.promptStart, h.promptEnd])).toEqual([
      [1, 4],
      [5, 8],
    ]);
    expect(lines).toHaveLength(8);
  });

  it("lists the paths a base snapshot needs", () => {
    expect(oldPathsOf(files)).toEqual(["src/a.ts", "docs/old.md", "pnpm-lock.yaml"]);
  });

  it("writes one diff per file and an index with modes and hunk spans", () => {
    const dir = path.join(root, "pr-diff");
    const entries = describeChangedFiles(
      files,
      {
        groups: [{ label: "all changed files", files: [files[0]], estimatedTokens: 1 }],
        onDemand: [],
      },
      [{ path: "pnpm-lock.yaml", reason: "generated_or_lockfile" }],
    );
    writeDiffMount(dir, PR_DIFF_MOUNT, files, "Changes of PR #1", entries, 1);

    expect(fs.readFileSync(path.join(dir, "src", "a.ts.diff"), "utf-8")).toBe(files[0].promptDiff);
    const index = fs.readFileSync(path.join(dir, "index.md"), "utf-8");
    expect(index).toContain("src/a.ts (modify, +2 -1): group 1/1, inline");
    expect(index).toContain("@@ -20,2 +21,2 @@ second → R21-R22; @pr-diff/src/a.ts.diff lines 5-8");
    expect(index).toContain("docs/old.md (delete, +0 -1): previously reviewed");
    expect(index).toContain("pnpm-lock.yaml (modify, +1 -1): skipped: generated or lockfile");
  });

  it("never writes outside the mount directory", () => {
    const evil = parseGitDiff(
      "diff --git a/../evil.ts b/../evil.ts\n--- a/../evil.ts\n+++ b/../evil.ts\n@@ -1 +1 @@\n-a\n+b\n",
    ).files;
    const dir = path.join(root, "evil");
    writeDiffMount(dir, PR_DIFF_MOUNT, evil, "evil");
    expect(fs.existsSync(path.join(root, "evil.ts.diff"))).toBe(false);
  });

  it("orders mounts the same way regardless of insertion order", () => {
    const names = describeMounts([CI_LOGS_MOUNT, BASE_MOUNT, PR_DIFF_MOUNT]).map((m) => m.name);
    expect(names).toEqual([PR_DIFF_MOUNT, BASE_MOUNT, CI_LOGS_MOUNT]);
    expect(describeMounts([CI_LOGS_MOUNT])[0].untrusted).toBe(true);
  });
});

describe("CoverageTracker", () => {
  const file = parseGitDiff(DIFF).files[0];
  const mounted = `${PR_DIFF_MOUNT}/src/a.ts.diff`;

  it("counts a hunk once its whole span was returned, across several reads", () => {
    const tracker = new CoverageTracker();
    tracker.trackMounted(PR_DIFF_MOUNT, file, "oversized");
    tracker.recordRead(mounted, 1, 3);
    expect(tracker.summary().mountedHunksRead).toBe(0);
    tracker.recordRead(mounted, 4, 6);
    const partial = tracker.summary();
    expect(partial.mountedHunksRead).toBe(1);
    expect(partial.unreadFiles).toEqual([
      { path: "src/a.ts", mode: "oversized", totalHunks: 2, unread: ["R21-R22"] },
    ]);
    tracker.recordRead(mounted, 5, 8);
    expect(tracker.summary().unreadFiles).toEqual([]);
  });

  it("ignores reads of other files and counts inline files separately", () => {
    const tracker = new CoverageTracker();
    tracker.trackInline(file);
    tracker.recordRead("src/a.ts", 1, 100);
    expect(tracker.summary()).toMatchObject({ inlineFiles: 1, mountedFiles: 0, unreadFiles: [] });
  });
});
