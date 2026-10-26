import type { ParsedFileDiff } from "./diff-parser.js";
import { estimateTokens } from "../runtime/budget.js";

export interface FileGroup {
  label: string;
  files: ParsedFileDiff[];
  estimatedTokens: number;
  /** A single file too large for a prompt: the group gets its hunk index and reads it from a mount. */
  oversized?: boolean;
}

/**
 * Largest diff (prompt tokens) one file group may carry.
 *
 * The diff sits in the frozen part of the conversation, and memory compression targets
 * `maxContextTokens × warningWatermark × 0.5` for frozen + memory + recent rounds. Keeping the diff
 * to half of that target leaves at least as much room for exploration (file reads, searches) as the
 * diff itself takes.
 */
export function groupTokenBudget(maxContextTokens: number, warningWatermark: number): number {
  return Math.floor(maxContextTokens * warningWatermark * 0.25);
}

/** A file whose diff alone exceeds the group budget is reviewed from a mount, not inline. */
export function isOversized(file: ParsedFileDiff, budget: number): boolean {
  return estimateTokens(file.promptDiff) > budget;
}

/**
 * Splits a PR's reviewable files into groups, each reviewed in its own conversation.
 *
 * Split only when needed: a PR whose diff fits the budget is reviewed as one group, so the agent
 * sees every change together and explores the repository once. Larger PRs are packed greedily in
 * path order, which keeps files of the same directory next to each other. A file over the budget
 * becomes an oversized group of its own.
 */
export function partitionFileGroups(diffs: ParsedFileDiff[], budget: number): FileGroup[] {
  if (diffs.length === 0) return [];

  const sized = [...diffs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ file, tokens: estimateTokens(file.promptDiff) }));
  const total = sized.reduce((sum, s) => sum + s.tokens, 0);
  if (total <= budget) {
    return [
      { label: "all changed files", files: sized.map((s) => s.file), estimatedTokens: total },
    ];
  }

  const packed: { files: ParsedFileDiff[]; tokens: number; oversized?: boolean }[] = [];
  let current: { files: ParsedFileDiff[]; tokens: number } | null = null;
  for (const { file, tokens } of sized) {
    if (tokens > budget) {
      // Its own group; the group being packed stays open for the files that follow.
      packed.push({ files: [file], tokens, oversized: true });
      continue;
    }
    if (!current || current.tokens + tokens > budget) {
      current = { files: [], tokens: 0 };
      packed.push(current);
    }
    current.files.push(file);
    current.tokens += tokens;
  }

  return packed.map((g, i) => {
    const first = g.files[0].path;
    const last = g.files[g.files.length - 1].path;
    const span = g.files.length === 1 ? first : `${first} … ${last}`;
    return {
      label: `part ${i + 1}/${packed.length}: ${span}`,
      files: g.files,
      estimatedTokens: g.tokens,
      ...(g.oversized ? { oversized: true } : {}),
    };
  });
}

// Tests and docs rarely hide defects that matter, and the code they describe is reviewed anyway.
// Configuration is not on the list: it changes behavior (and CI workflows are a security surface).
const LOW_RISK_PATTERNS = [
  /(^|\/)(tests?|__tests__|specs?|testdata|fixtures?|__snapshots__)\//,
  /\.(test|spec)\.[^/]+$/,
  /_test\.(go|py|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
  /\.(md|mdx|rst|adoc|txt)$/i,
  /(^|\/)docs?\//,
];

export function isLowRiskPath(filePath: string): boolean {
  if (filePath.startsWith(".github/")) return false;
  return LOW_RISK_PATTERNS.some((p) => p.test(filePath));
}

export interface ReviewPlan {
  groups: FileGroup[];
  /** Low-risk files left out of every group, reviewed on demand from the diff mount. */
  onDemand: ParsedFileDiff[];
}

/**
 * Groups the files, and when that takes more than `maxInlineGroups` conversations (the budget
 * would be spread too thin), leaves the low-risk files (tests, docs) out of the groups so the
 * budget goes to the code. They stay readable from the diff mount and are reported as on-demand.
 * `maxInlineGroups` 0 never demotes; a PR made only of low-risk files is reviewed in full.
 */
export function planFileGroups(
  diffs: ParsedFileDiff[],
  budget: number,
  maxInlineGroups: number,
): ReviewPlan {
  const groups = partitionFileGroups(diffs, budget);
  if (maxInlineGroups <= 0 || groups.length <= maxInlineGroups) return { groups, onDemand: [] };
  const core = diffs.filter((f) => !isLowRiskPath(f.path));
  if (core.length === 0 || core.length === diffs.length) return { groups, onDemand: [] };
  return {
    groups: partitionFileGroups(core, budget),
    onDemand: diffs.filter((f) => isLowRiskPath(f.path)),
  };
}
