import type { ParsedFileDiff } from "./diff-parser.js";
import { countTokens } from "../runtime/budget.js";

export interface FileGroup {
  label: string;
  files: ParsedFileDiff[];
  estimatedTokens: number;
}

/**
 * Largest diff (prompt tokens) one file group may carry.
 *
 * The diff sits in the frozen part of the conversation, and memory compression targets
 * `maxContextTokens × warningWatermark × 0.5` for frozen + memory + recent rounds. Keeping the diff
 * to half of that target leaves at least as much room for exploration (file reads, searches) as the
 * diff itself takes. Example: 128k window × 0.8 × 0.25 ≈ 25.6k tokens.
 */
export function groupTokenBudget(maxContextTokens: number, warningWatermark: number): number {
  return Math.floor(maxContextTokens * warningWatermark * 0.25);
}

/**
 * Splits a PR's reviewable files into groups, each reviewed in its own conversation.
 *
 * Split only when needed: a PR whose diff fits the budget is reviewed as one group, so the agent
 * sees every change together and explores the repository once. Larger PRs are packed greedily in
 * path order, which keeps files of the same directory next to each other. A single file over the
 * budget becomes a group of its own.
 */
export function partitionFileGroups(diffs: ParsedFileDiff[], budget: number): FileGroup[] {
  if (diffs.length === 0) return [];

  const sized = [...diffs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ file, tokens: countTokens(file.promptDiff) }));
  const total = sized.reduce((sum, s) => sum + s.tokens, 0);
  if (total <= budget) {
    return [
      { label: "all changed files", files: sized.map((s) => s.file), estimatedTokens: total },
    ];
  }

  const packed: { files: ParsedFileDiff[]; tokens: number }[] = [];
  let current: { files: ParsedFileDiff[]; tokens: number } | null = null;
  for (const { file, tokens } of sized) {
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
    };
  });
}
