import { describe, it, expect } from "vite-plus/test";
import { parseSummaryFindings } from "./history.js";
import { ReviewPayloadAssembler } from "../domain/assembler.js";
import { parseGitDiff } from "../domain/diff-parser.js";
import { DiffAnchorRelocator } from "../domain/relocator.js";
import { buildInitialUserPrompt } from "../domain/prompt.js";
import type { EmittedComment } from "../domain/github-types.js";

const DIFF = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
new file mode 100644
--- /dev/null
+++ b/.github/workflows/ci.yml
@@ -0,0 +1,3 @@
+name: CI
+on: [push]
+jobs: {}
`;

const comment = (over: Partial<EmittedComment>): EmittedComment => ({
  id: "c",
  path: ".github/workflows/ci.yml",
  line: 2,
  side: "RIGHT",
  severity: "P3",
  category: "maintainability",
  title: "No concurrency group: superseded runs pile up",
  body: "...",
  ...over,
});

describe("review history", () => {
  it("reads back the findings listed in a summary the assembler wrote", () => {
    const payload = ReviewPayloadAssembler.assemble({
      owner: "o",
      repo: "r",
      pull_number: 1,
      commit_id: "abc",
      comments: [
        comment({ id: "1" }),
        comment({ id: "2", severity: "P2", line: 3, title: "Job has no `timeout-minutes`" }),
      ],
      relocator: new DiffAnchorRelocator(parseGitDiff(DIFF)),
    });

    expect(parseSummaryFindings(payload.body ?? "")).toEqual([
      {
        severity: "P2",
        path: ".github/workflows/ci.yml",
        line: 3,
        title: "Job has no `timeout-minutes`",
      },
      {
        severity: "P3",
        path: ".github/workflows/ci.yml",
        line: 2,
        title: "No concurrency group: superseded runs pile up",
      },
    ]);
  });

  it("finds nothing in a summary without findings or in a human review", () => {
    expect(parseSummaryFindings("## PR-Agent Review Summary\n\n*No actionable defects*")).toEqual(
      [],
    );
    expect(parseSummaryFindings("LGTM, thanks!")).toEqual([]);
  });

  it("tells the agent the review scope and the findings it must not repeat", () => {
    const prompt = buildInitialUserPrompt({
      groupLabel: "all changed files",
      groupFiles: [],
      groupCount: 1,
      confirmedComments: [],
      previousFindings: [
        { severity: "P3", path: "ci.yml", line: 6, title: "No concurrency group" },
      ],
      reviewScope: "This PR was already reviewed at commit d2a6318.",
    });
    expect(prompt).toContain(
      "<review_scope>\nThis PR was already reviewed at commit d2a6318.\n</review_scope>",
    );
    expect(prompt).toContain("- [P3] ci.yml:6: No concurrency group\n");
    expect(prompt).toContain("do not report them again");
  });
});
