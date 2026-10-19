import type { ParsedFileDiff } from "./diff-parser.js";
import { countTokens } from "../runtime/budget.js";

export interface FileGroup {
  label: string;
  files: ParsedFileDiff[];
  estimatedTokens: number;
}

export const MAX_FILES_PER_GROUP = 10;

/**
 * Partitions diffs into bounded semantic groups with per-group token budgets.
 */
export function partitionFileGroups(
  diffs: ParsedFileDiff[],
  tokenLimitPerGroup: number,
): FileGroup[] {
  if (diffs.length === 0) return [];

  // Group by directory path as baseline semantic clustering
  const dirBuckets = new Map<string, ParsedFileDiff[]>();

  for (const d of diffs) {
    const parts = d.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, parts.length - 1).join("/") : "root";
    if (!dirBuckets.has(dir)) {
      dirBuckets.set(dir, []);
    }
    dirBuckets.get(dir)!.push(d);
  }

  const rawGroups: FileGroup[] = [];

  for (const [dir, files] of dirBuckets.entries()) {
    // Chunk if directory contains more than MAX_FILES_PER_GROUP
    for (let i = 0; i < files.length; i += MAX_FILES_PER_GROUP) {
      const chunk = files.slice(i, i + MAX_FILES_PER_GROUP);
      const estTokens = chunk.reduce((sum, f) => sum + countTokens(f.rawDiff), 0);
      rawGroups.push({
        label:
          files.length > MAX_FILES_PER_GROUP
            ? `${dir} (part ${Math.floor(i / MAX_FILES_PER_GROUP) + 1})`
            : dir,
        files: chunk,
        estimatedTokens: estTokens,
      });
    }
  }

  // Enforce token budget per group: if combined diff tokens exceed budget, split into single-file groups
  const finalGroups: FileGroup[] = [];

  for (const g of rawGroups) {
    if (tokenLimitPerGroup > 0 && g.estimatedTokens > tokenLimitPerGroup && g.files.length > 1) {
      for (const f of g.files) {
        finalGroups.push({
          label: `${g.label} (split: ${f.path})`,
          files: [f],
          estimatedTokens: countTokens(f.rawDiff),
        });
      }
    } else {
      finalGroups.push(g);
    }
  }

  return finalGroups;
}
