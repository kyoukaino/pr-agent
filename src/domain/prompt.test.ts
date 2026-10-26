import { describe, it, expect } from "vite-plus/test";
import { parseGitDiff } from "./diff-parser.js";
import { buildFollowUpMessage, buildInitialUserPrompt, type PromptBuildParams } from "./prompt.js";
import { PR_DIFF_MOUNT, describeMounts, type ChangedFileEntry } from "./workspace.js";

const files = parseGitDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@ head
 one
+two
diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -10,1 +10,2 @@ fn
 x
+y
@@ -40,1 +41,1 @@ other
-old
+new
`).files;

const changedFiles: ChangedFileEntry[] = [
  { path: "src/a.ts", type: "modify", insertions: 1, deletions: 0, mode: "inline", group: 1 },
  { path: "src/big.ts", type: "modify", insertions: 2, deletions: 1, mode: "oversized", group: 2 },
];

const common: Omit<PromptBuildParams, "groupLabel" | "groupFiles"> = {
  groupCount: 2,
  changedFiles,
  workspace: describeMounts([PR_DIFF_MOUNT]),
  background: "PR title: Add things",
  ciResults: "- build (success)",
  confirmedComments: [],
  previousFindings: [{ severity: "P3", path: "src/a.ts", line: 1, title: "Old finding" }],
};

describe("initial task layout", () => {
  const first = buildInitialUserPrompt({
    ...common,
    groupLabel: "part 1/2: src/a.ts",
    groupFiles: [{ diff: files[0] }],
  });
  const second = buildInitialUserPrompt({
    ...common,
    groupLabel: "part 2/2: src/big.ts",
    groupFiles: [{ diff: files[1], mountedAt: PR_DIFF_MOUNT }],
    confirmedComments: [
      {
        id: "f1",
        path: "src/a.ts",
        line: 2,
        side: "RIGHT",
        severity: "P2",
        category: "bug",
        title: "From group 1",
        body: "",
      },
    ],
  });

  it("puts everything shared by the groups first, so they share the cache prefix", () => {
    const split = (p: string) => p.slice(0, p.indexOf("Your file group:"));
    expect(split(first)).toBe(split(second));
    for (const section of [
      "<requirement_background>",
      "<ci_results",
      "<workspace>",
      "<changed_files",
      "<findings_from_previous_reviews>",
    ]) {
      expect(split(first)).toContain(section);
    }
    expect(split(first)).not.toContain("part 1/2");
  });

  it("lists every file with its group and review mode", () => {
    expect(first).toContain("- src/a.ts (modify, +1 -0): group 1/2, inline");
    expect(first).toContain("- src/big.ts (modify, +2 -1): group 2/2, oversized");
    expect(first).toContain(`- ${PR_DIFF_MOUNT}: every change of this PR`);
  });

  it("keeps the group's own findings and diffs after the group name", () => {
    const own = second.slice(second.indexOf("Your file group:"));
    expect(own).toContain('"part 2/2: src/big.ts"');
    expect(own).toContain("- [P2] src/a.ts:2: From group 1");
    expect(first).toContain("R2 + two");
  });

  it("renders an oversized file as a hunk index into the mount", () => {
    expect(second).toContain(
      `<file_diff path="src/big.ts" type="modify" mode="mounted" source="${PR_DIFF_MOUNT}/src/big.ts.diff">`,
    );
    expect(second).toContain(
      `@@ -10,1 +10,2 @@ fn → R10-R11; ${PR_DIFF_MOUNT}/src/big.ts.diff lines 1-3`,
    );
    expect(second).toContain(
      `@@ -40,1 +41,1 @@ other → R41-R41; ${PR_DIFF_MOUNT}/src/big.ts.diff lines 4-6`,
    );
    expect(second).not.toContain("R11 + y");
  });
});

describe("follow-up message", () => {
  it("tells the agent the workspace now reflects the new head", () => {
    const msg = buildFollowUpMessage({
      commit: "c10201f0000",
      sinceCommit: "36fb1e40000",
      diffs: [{ diff: files[1], mountedAt: "@incremental-diff" }],
      workspace: describeMounts([PR_DIFF_MOUNT, "@incremental-diff"]),
      openFindings: [],
      confirmedComments: [],
    });
    expect(msg.content).toContain("now reflect the new head");
    expect(msg.content).toContain("- @incremental-diff: the changes pushed since");
    expect(msg.content).toContain('source="@incremental-diff/src/big.ts.diff"');
  });
});
