import { describe, it, expect } from "vite-plus/test";
import { groupTokenBudget, partitionFileGroups } from "./grouping.js";
import { countTokens } from "../runtime/budget.js";
import type { ParsedFileDiff } from "./diff-parser.js";

function file(path: string, words: number): ParsedFileDiff {
  const promptDiff = `R1 + ${"token ".repeat(words)}`;
  return {
    path,
    type: "modify",
    isBinary: false,
    insertions: 1,
    deletions: 0,
    churn: 1,
    hunkRanges: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: "@@" }],
    rawDiff: promptDiff,
    promptDiff,
  };
}

describe("partitionFileGroups", () => {
  it("derives the group budget from the compression target", () => {
    expect(groupTokenBudget(128_000, 0.8)).toBe(25_600);
  });

  it("keeps a PR that fits the budget in one group, however many directories it touches", () => {
    const diffs = [file("b/x.ts", 10), file("a/deep/y.ts", 10), file("c/z.ts", 10)];
    const groups = partitionFileGroups(diffs, 1_000);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("all changed files");
    expect(groups[0].files.map((f) => f.path)).toEqual(["a/deep/y.ts", "b/x.ts", "c/z.ts"]);
  });

  it("packs larger PRs in path order without exceeding the budget", () => {
    const size = countTokens(file("x", 100).promptDiff);
    const diffs = ["src/d.ts", "src/a.ts", "lib/b.ts", "src/c.ts", "lib/a.ts"].map((p) =>
      file(p, 100),
    );
    const groups = partitionFileGroups(diffs, size * 2);

    expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([
      ["lib/a.ts", "lib/b.ts"],
      ["src/a.ts", "src/c.ts"],
      ["src/d.ts"],
    ]);
    expect(groups.every((g) => g.estimatedTokens <= size * 2)).toBe(true);
    expect(groups[0].label).toBe("part 1/3: lib/a.ts … lib/b.ts");
    expect(groups[2].label).toBe("part 3/3: src/d.ts");
  });

  it("gives a file larger than the budget a group of its own", () => {
    const groups = partitionFileGroups(
      [file("a.ts", 10), file("big.ts", 500), file("c.ts", 10)],
      100,
    );
    expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([["a.ts"], ["big.ts"], ["c.ts"]]);
  });
});
