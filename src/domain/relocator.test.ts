import { describe, it, expect } from "vite-plus/test";
import { parseGitDiff } from "./diff-parser.js";
import { DiffAnchorRelocator } from "./relocator.js";
import type { EmittedComment } from "./github-types.js";

const SAMPLE_DIFF = `diff --git a/src/service.ts b/src/service.ts
index 000..111 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -20,5 +20,7 @@ export class Service {
   run() {
+    const a = 1;
+    const b = 2;
     return a + b;
   }
 }
`;

const base: EmittedComment = {
  id: "c",
  path: "src/service.ts",
  line: 22,
  side: "RIGHT",
  severity: "P1",
  category: "bug",
  title: "Hardcoded constant",
  body: "Avoid hardcoding values.",
};

describe("DiffAnchorRelocator", () => {
  const relocator = new DiffAnchorRelocator(parseGitDiff(SAMPLE_DIFF));

  it("keeps comments whose line is inside a hunk", () => {
    const res = relocator.anchor(base);
    expect(res.kind).toBe("inline");
    if (res.kind !== "inline") return;
    expect(res.comment.line).toBe(22);
    expect(res.comment.side).toBe("RIGHT");
    expect(res.comment.body).toContain("[P1]");
  });

  it("clamps comments close to a hunk and drops their suggestion", () => {
    const res = relocator.anchor({ ...base, line: 28, suggested_code: "const a = 3;" });
    expect(res.kind).toBe("inline");
    if (res.kind !== "inline") return;
    expect(res.comment.line).toBe(26); // hunk 20..26 on the new side
    expect(res.comment.body).toContain("anchored to nearest modified diff hunk");
    expect(res.comment.body).not.toContain("```suggestion");
  });

  it("does not emit an inline comment without a line (GitHub would 422 the whole review)", () => {
    const res = relocator.anchor({ ...base, line: 500 });
    expect(res.kind).toBe("unanchored");
  });

  it("treats files outside the diff as unanchored", () => {
    expect(relocator.anchor({ ...base, path: "src/other.ts" }).kind).toBe("unanchored");
  });

  it("validates LEFT-side comments against old-file line ranges", () => {
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -100,3 +10,2 @@
 keep
-removed
 keep2
`);
    const r = new DiffAnchorRelocator(diff);
    const left = r.anchor({ ...base, path: "a.ts", side: "LEFT", line: 101 });
    expect(left.kind).toBe("inline");
    if (left.kind === "inline") expect(left.comment.side).toBe("LEFT");
    // Line 101 does not exist on the new side (10..11) and is far away from it.
    expect(r.anchor({ ...base, path: "a.ts", side: "RIGHT", line: 101 }).kind).toBe("unanchored");
  });

  it("keeps a multi-line range only when it stays inside the hunk", () => {
    const res = relocator.anchor({ ...base, start_line: 21, line: 23 });
    expect(res.kind === "inline" && res.comment.start_line).toBe(21);
    const outside = relocator.anchor({ ...base, start_line: 5, line: 23 });
    expect(outside.kind === "inline" && outside.comment.start_line).toBeUndefined();
  });
});
