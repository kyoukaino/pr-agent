import * as fs from "node:fs";
import * as path from "node:path";
import type { DiffHunkRange, ParsedFileDiff } from "./diff-parser.js";
import type { ReviewPlan } from "./grouping.js";

/**
 * The review workspace: read-only directories mounted under an `@name` prefix next to the
 * repository, reachable with read_file and grep_code. Everything the agent may need beyond the code
 * at the head revision is exposed this way, so adding a source never changes the tool set (and
 * with it the prompt-cache prefix).
 */

/** Every change of the PR (merge base → head), one `<path>.diff` per file plus `index.md`. */
export const PR_DIFF_MOUNT = "@pr-diff";
/** Incremental reviews: the changes pushed since the last reviewed commit, same layout. */
export const INCREMENTAL_DIFF_MOUNT = "@incremental-diff";
/** The merge-base version of every file the PR modifies, deletes or renames. */
export const BASE_MOUNT = "@base";
/** PR description and commit messages, written by PR participants. */
export const PR_INFO_MOUNT = "@pr";
/** Logs of failed CI jobs of the head commit. */
export const CI_LOGS_MOUNT = "@ci-logs";

/** Mounts holding rendered diffs: read_file shows them without its own line numbers. */
export const DIFF_MOUNTS: readonly string[] = [PR_DIFF_MOUNT, INCREMENTAL_DIFF_MOUNT];

const MOUNT_DESCRIPTIONS: Record<string, { text: string; untrusted?: boolean }> = {
  [PR_DIFF_MOUNT]: {
    text: "every change of this PR: <path>.diff per file with the same R<n>/L<n> anchors as the diffs below (usable in code_comment); index.md lists files, hunks and line spans",
  },
  [INCREMENTAL_DIFF_MOUNT]: {
    text: "the changes pushed since the last reviewed commit, same layout as @pr-diff",
  },
  [BASE_MOUNT]: {
    text: "the merge-base version (before this PR) of every file the PR modifies, deletes or renames, at its old path",
  },
  [PR_INFO_MOUNT]: {
    text: "description.md (full PR description) and commits.md (commit messages)",
    untrusted: true,
  },
  [CI_LOGS_MOUNT]: {
    text: "logs of failed CI jobs, as listed in <ci_results>",
    untrusted: true,
  },
};

const MOUNT_ORDER = [
  PR_DIFF_MOUNT,
  INCREMENTAL_DIFF_MOUNT,
  BASE_MOUNT,
  PR_INFO_MOUNT,
  CI_LOGS_MOUNT,
];

export interface WorkspaceMount {
  name: string;
  description: string;
  untrusted: boolean;
}

/** The mounts of a review in a fixed order, so the prompt section is identical across groups. */
export function describeMounts(names: Iterable<string>): WorkspaceMount[] {
  const rank = (n: string) =>
    MOUNT_ORDER.includes(n) ? MOUNT_ORDER.indexOf(n) : MOUNT_ORDER.length;
  return [...new Set(names)]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => ({
      name,
      description: MOUNT_DESCRIPTIONS[name]?.text ?? "read-only directory",
      untrusted: MOUNT_DESCRIPTIONS[name]?.untrusted ?? false,
    }));
}

/**
 * How the review covers a changed file:
 * - inline: its diff is in its group's prompt;
 * - oversized: too large for a prompt, its group gets a hunk index and reads the diff from a mount;
 * - on_demand: low-risk file left out of every group (large PRs), read from a mount when relevant;
 * - previously_reviewed: unchanged since the last reviewed commit (incremental review);
 * - skipped: not reviewed (generated or lock file, no text hunks).
 */
export type ReviewMode = "inline" | "oversized" | "on_demand" | "previously_reviewed" | "skipped";

export interface ChangedFileEntry {
  path: string;
  type: ParsedFileDiff["type"];
  insertions: number;
  deletions: number;
  mode: ReviewMode;
  /** 1-based index of the file group reviewing it. */
  group?: number;
  /** Why a skipped file is not reviewed. */
  reason?: string;
}

/**
 * How the review covers every file of the PR. Files outside `plan` and not skipped are unchanged
 * since the last review (an incremental review covers only the new changes).
 */
export function describeChangedFiles(
  prFiles: ParsedFileDiff[],
  plan: ReviewPlan,
  skipped: { path: string; reason: string }[],
): ChangedFileEntry[] {
  const groupOf = new Map<string, { group: number; oversized: boolean }>();
  plan.groups.forEach((g, i) => {
    for (const f of g.files) groupOf.set(f.path, { group: i + 1, oversized: Boolean(g.oversized) });
  });
  const onDemand = new Set(plan.onDemand.map((f) => f.path));
  const skipReason = new Map(skipped.map((s) => [s.path, s.reason.replace(/_/g, " ")]));
  return prFiles.map((f): ChangedFileEntry => {
    const base = { path: f.path, type: f.type, insertions: f.insertions, deletions: f.deletions };
    const reason = skipReason.get(f.path);
    if (reason) return { ...base, mode: "skipped", reason };
    const g = groupOf.get(f.path);
    if (g) return { ...base, mode: g.oversized ? "oversized" : "inline", group: g.group };
    return { ...base, mode: onDemand.has(f.path) ? "on_demand" : "previously_reviewed" };
  });
}

/** Location of a file's rendered diff inside a diff mount. */
export function diffFilePath(mount: string, filePath: string): string {
  return `${mount}/${filePath}.diff`;
}

/** New-side line span of a hunk as R anchors, or the old side for a pure deletion. */
export function hunkSpan(h: DiffHunkRange): string {
  if (h.newLines > 0) return `R${h.newStart}-R${h.newStart + h.newLines - 1}`;
  return `L${h.oldStart}-L${h.oldStart + Math.max(0, h.oldLines - 1)}`;
}

function describeEntry(e: ChangedFileEntry, groupCount: number): string {
  const where =
    e.mode === "inline" || e.mode === "oversized"
      ? `group ${e.group}/${groupCount}, ${e.mode}`
      : e.mode === "skipped"
        ? `skipped: ${e.reason ?? "not reviewed"}`
        : e.mode.replace("_", " ");
  return `${e.path} (${e.type}, +${e.insertions} -${e.deletions}): ${where}`;
}

/** One line per changed file, for the `<changed_files>` prompt section and the mount index. */
export function renderChangedFiles(entries: ChangedFileEntry[], groupCount: number): string {
  return entries.map((e) => `- ${describeEntry(e, groupCount)}`).join("\n");
}

/** Hunk headers with their anchors and their line span in the mounted diff file. */
export function renderHunkIndex(file: ParsedFileDiff, mount: string): string {
  const source = diffFilePath(mount, file.path);
  return file.hunkRanges
    .map(
      (h) =>
        `- ${h.header.trim()} → ${hunkSpan(h)}; ${source} lines ${h.promptStart}-${h.promptEnd}`,
    )
    .join("\n");
}

/**
 * Writes a diff mount: `<path>.diff` holds the file's promptDiff unchanged (so the hunk index line
 * spans match), `index.md` the file list. Paths that would leave the directory are not written.
 */
export function writeDiffMount(
  dir: string,
  mount: string,
  files: ParsedFileDiff[],
  title: string,
  entries?: ChangedFileEntry[],
  groupCount = 1,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  const written: ParsedFileDiff[] = [];
  for (const f of files) {
    if (f.hunkRanges.length === 0) continue;
    const target = path.resolve(root, `${f.path}.diff`);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.promptDiff, "utf-8");
    written.push(f);
  }

  const byPath = new Map(entries?.map((e) => [e.path, e]));
  let index = `# ${title}\n\n${written.length} file diff(s); each hunk lists its anchors and its line span in the .diff file.\n\n`;
  for (const f of written) {
    const entry = byPath.get(f.path);
    index += entry
      ? `${describeEntry(entry, groupCount)}\n`
      : `${f.path} (${f.type}, +${f.insertions} -${f.deletions})\n`;
    index += `${renderHunkIndex(f, mount)}\n\n`;
  }
  fs.writeFileSync(path.join(root, "index.md"), index, "utf-8");
}
