import { describe, it, expect } from "vite-plus/test";
import { ReviewPayloadAssembler, selectPostedComments } from "./assembler.js";
import { parseGitDiff } from "./diff-parser.js";
import { DiffAnchorRelocator } from "./relocator.js";
import type { EmittedComment } from "./github-types.js";

const SAMPLE_DIFF = `diff --git a/main.go b/main.go
index 000..111 100644
--- a/main.go
+++ b/main.go
@@ -1,3 +1,5 @@
 package main
+func test() {}
 func main() {}
`;

describe("ReviewPayloadAssembler", () => {
  const prDiff = parseGitDiff(SAMPLE_DIFF);
  const relocator = new DiffAnchorRelocator(prDiff);

  it("should output APPROVE when no comments are present", () => {
    const payload = ReviewPayloadAssembler.assemble({
      owner: "alibaba",
      repo: "open-code-review",
      pull_number: 101,
      commit_id: "abcdef",
      comments: [],
      relocator,
    });

    expect(payload.event).toBe("APPROVE");
    expect(payload.comments).toHaveLength(0);
    expect(payload.body).toContain("No actionable defects identified");
  });

  it("should output REQUEST_CHANGES when P0 or P1 comments are present", () => {
    const comments: EmittedComment[] = [
      {
        id: "c1",
        path: "main.go",
        line: 2,
        side: "RIGHT",
        severity: "P0",
        category: "security",
        title: "SQL Injection",
        body: "Severe vulnerability detected.",
      },
    ];

    const payload = ReviewPayloadAssembler.assemble({
      owner: "alibaba",
      repo: "open-code-review",
      pull_number: 101,
      commit_id: "abcdef",
      comments,
      relocator,
    });

    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments?.[0].line).toBe(2);
    expect(payload.body).toContain("**P0 (Blocker)** | 1");
  });

  it("should output COMMENT when only P2/P3/P4 comments are present", () => {
    const comments: EmittedComment[] = [
      {
        id: "c2",
        path: "main.go",
        line: 2,
        side: "RIGHT",
        severity: "P3",
        category: "maintainability",
        title: "Naming convention",
        body: "Consider naming function meaningfully.",
      },
    ];

    const payload = ReviewPayloadAssembler.assemble({
      owner: "alibaba",
      repo: "open-code-review",
      pull_number: 101,
      commit_id: "abcdef",
      comments,
      relocator,
    });

    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(1);
  });
});

describe("selectPostedComments", () => {
  const finding = (id: string, severity: EmittedComment["severity"]): EmittedComment => ({
    id,
    path: "main.go",
    line: 2,
    side: "RIGHT",
    severity,
    category: severity === "P4" ? "documentation" : "bug",
    title: id,
    body: "",
  });

  it("keeps the most severe findings when the cap is hit (regression: cap kept emission order)", () => {
    const comments = [
      finding("typo-1", "P4"),
      finding("typo-2", "P4"),
      finding("logic", "P2"),
      finding("typo-3", "P4"),
      finding("backdoor", "P0"),
    ];
    expect(selectPostedComments(comments, 3).map((c) => c.id)).toEqual([
      "backdoor",
      "logic",
      "typo-1",
    ]);
  });
});

describe("verdict of a follow-up review", () => {
  const relocator = new DiffAnchorRelocator(parseGitDiff(SAMPLE_DIFF));
  const base = { owner: "o", repo: "r", pull_number: 1, commit_id: "c", comments: [], relocator };

  it("is not an approval while earlier findings stay open", () => {
    const blocked = ReviewPayloadAssembler.assemble({ ...base, stillOpen: [{ severity: "P1" }] });
    expect(blocked.event).toBe("REQUEST_CHANGES");
    const minor = ReviewPayloadAssembler.assemble({
      ...base,
      stillOpen: [{ severity: "P3" }],
      resolvedCount: 1,
    });
    expect(minor.event).toBe("COMMENT");
    expect(minor.body).toContain("Earlier findings: 1 resolved in this review, 1 still open.");
    expect(minor.body).toContain("No new defects in these changes.");
  });

  it("approves once nothing new was found and nothing earlier is open", () => {
    const clean = ReviewPayloadAssembler.assemble({ ...base, stillOpen: [], resolvedCount: 2 });
    expect(clean.event).toBe("APPROVE");
  });
});
