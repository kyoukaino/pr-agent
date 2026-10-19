import { describe, it, expect } from "vite-plus/test";
import { parseGitDiff, isGeneratedOrLockfile, buildConcatenatedDiffsXML } from "./diff-parser.js";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export function login(user: string, pass: string) {
   const hashed = hash(pass);
+  // Added check
+  if (!user) throw new Error("No user");
   return check(user, hashed);
 }
`;

describe("diff-parser", () => {
  it("should parse diff correctly with hunks and churn", () => {
    const parsed = parseGitDiff(SAMPLE_DIFF);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file.path).toBe("src/auth.ts");
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.churn).toBe(2);
    expect(file.hunkRanges).toHaveLength(1);
    expect(file.hunkRanges[0].newStart).toBe(10);
    expect(file.hunkRanges[0].newLines).toBe(8);
  });

  it("should identify lockfiles and minified files", () => {
    expect(isGeneratedOrLockfile("package-lock.json")).toBe(true);
    expect(isGeneratedOrLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isGeneratedOrLockfile("bundle.min.js")).toBe(true);
    expect(isGeneratedOrLockfile("src/index.ts")).toBe(false);
  });

  it("should generate concatenated XML elements", () => {
    const parsed = parseGitDiff(SAMPLE_DIFF);
    const xml = buildConcatenatedDiffsXML(parsed.files);
    expect(xml).toContain('<file_diff path="src/auth.ts" type="modify">');
    expect(xml).toContain("</file_diff>");
  });
});

describe("promptDiff line anchors", () => {
  it("labels new-side lines R<n> and deleted lines L<n>", () => {
    const parsed = parseGitDiff(`diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@ fn
 keep1
-old
+new
 keep2
`);
    expect(parsed.files[0].promptDiff.split("\n").slice(1)).toEqual([
      "R10   keep1",
      "L11 - old",
      "R11 + new",
      "R12   keep2",
    ]);
  });
});
