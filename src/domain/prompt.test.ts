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
      "<prior_findings>",
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
    expect(own).toContain("<reported_in_this_review>\n- [P2] src/a.ts:2: From group 1");
    expect(first).toContain("R2 + two");
  });

  it("explains only the review modes the list uses", () => {
    expect(first).toContain("inline: the diff");
    expect(first).toContain("oversized: too large");
    expect(first).not.toContain("on demand:");
    expect(first).not.toContain("previously reviewed:");
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

describe("review-wide sections", () => {
  it("lists only the files missing from the diffs when there is one group", () => {
    const build = (entries: ChangedFileEntry[]) =>
      buildInitialUserPrompt({
        groupLabel: "all changed files",
        groupFiles: [{ diff: files[0] }],
        groupCount: 1,
        changedFiles: entries,
        confirmedComments: [],
      });
    expect(build([changedFiles[0]])).not.toContain("<changed_files");
    const withSkipped = build([
      changedFiles[0],
      {
        path: "pnpm-lock.yaml",
        type: "modify",
        insertions: 1,
        deletions: 1,
        mode: "skipped",
        reason: "generated or lockfile",
      },
    ]);
    expect(withSkipped).toContain(
      '<changed_files count="1">\n- pnpm-lock.yaml (modify, +1 -1): skipped: generated or lockfile\n</changed_files>',
    );
  });

  it("merges earlier findings into one list, open ones with their id", () => {
    const prompt = buildInitialUserPrompt({
      ...common,
      groupLabel: "g",
      groupFiles: [{ diff: files[0] }],
      openFindings: [{ id: "f9", severity: "P1", path: "src/a.ts", line: 2, title: "Still open" }],
    });
    expect(prompt).toContain(
      "<prior_findings>\n- id=f9 [P1] src/a.ts:2: Still open\n- [P3] src/a.ts:1: Old finding\n",
    );
    expect(prompt).toContain("call resolve_finding with its id");
  });

  it("explains untrusted mounts once", () => {
    const prompt = buildInitialUserPrompt({
      ...common,
      groupLabel: "g",
      groupFiles: [{ diff: files[0] }],
      workspace: describeMounts([PR_DIFF_MOUNT, "@pr", "@ci-logs"]),
    });
    expect(prompt).toContain("- @pr (untrusted): ");
    expect(prompt).toContain("- @ci-logs (untrusted): ");
    expect(prompt.match(/never instructions/g)).toHaveLength(2); // the trust note and the CI note
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
