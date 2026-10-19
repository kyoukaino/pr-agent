import gitDiffParser, { type File as GitDiffFile } from "gitdiff-parser";

// Safe resolve for CJS/ESM interop
const parseDiffFn = ((
  gitDiffParser as unknown as {
    parse?: (s: string) => GitDiffFile[];
    default?: { parse: (s: string) => GitDiffFile[] };
  }
).parse ||
  (gitDiffParser as unknown as { default?: { parse: (s: string) => GitDiffFile[] } }).default
    ?.parse ||
  gitDiffParser) as (s: string) => GitDiffFile[];

export interface DiffHunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
}

export interface ParsedFileDiff {
  path: string;
  oldPath?: string;
  newPath?: string;
  type: "add" | "delete" | "modify" | "rename";
  isBinary: boolean;
  insertions: number;
  deletions: number;
  churn: number;
  hunkRanges: DiffHunkRange[];
  rawDiff: string;
  /** Diff with explicit anchors for the model: R<n> = new-file line (RIGHT), L<n> = old-file line (LEFT). */
  promptDiff: string;
}

export interface ParsedPRDiff {
  files: ParsedFileDiff[];
  totalInsertions: number;
  totalDeletions: number;
  totalChurn: number;
  fileMap: Map<string, ParsedFileDiff>;
}

const GENERATED_FILE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.map$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /composer\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /\.generated\./,
];

export function isGeneratedOrLockfile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function parseGitDiff(rawDiff: string): ParsedPRDiff {
  const parsedFiles: GitDiffFile[] = parseDiffFn(rawDiff);

  const files: ParsedFileDiff[] = [];
  const fileMap = new Map<string, ParsedFileDiff>();

  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const f of parsedFiles) {
    const effectivePath =
      f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath || "unknown";
    let insertions = 0;
    let deletions = 0;

    const hunkRanges: DiffHunkRange[] = [];

    for (const h of f.hunks) {
      hunkRanges.push({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        header: h.content,
      });

      for (const c of h.changes) {
        if (c.type === "insert") insertions++;
        else if (c.type === "delete") deletions++;
      }
    }

    const fileDiff: ParsedFileDiff = {
      path: effectivePath,
      oldPath: f.oldPath,
      newPath: f.newPath,
      type: f.type as ParsedFileDiff["type"],
      isBinary: false, // gitdiff-parser text parser handles text hunks
      insertions,
      deletions,
      churn: insertions + deletions,
      hunkRanges,
      rawDiff: buildFileRawDiff(f),
      promptDiff: buildPromptDiff(f),
    };

    files.push(fileDiff);
    fileMap.set(effectivePath, fileDiff);
    totalInsertions += insertions;
    totalDeletions += deletions;
  }

  return {
    files,
    totalInsertions,
    totalDeletions,
    totalChurn: totalInsertions + totalDeletions,
    fileMap,
  };
}

function buildFileRawDiff(file: GitDiffFile): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${file.oldPath || file.newPath} b/${file.newPath || file.oldPath}`);
  for (const h of file.hunks) {
    lines.push(h.content);
    for (const c of h.changes) {
      const prefix = c.type === "insert" ? "+" : c.type === "delete" ? "-" : " ";
      lines.push(`${prefix}${c.content}`);
    }
  }
  return lines.join("\n");
}

interface NumberedChange {
  type: "insert" | "delete" | "normal";
  content: string;
  lineNumber?: number;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Renders hunks with the line numbers GitHub expects for review comments, so the model never has
 * to count lines inside a hunk: added/context lines carry their new-file number (side RIGHT),
 * deleted lines their old-file number (side LEFT).
 */
function buildPromptDiff(file: GitDiffFile): string {
  const lines: string[] = [];
  for (const h of file.hunks) {
    lines.push(h.content);
    for (const raw of h.changes) {
      const c = raw as unknown as NumberedChange;
      if (c.type === "insert") lines.push(`R${c.lineNumber} + ${c.content}`);
      else if (c.type === "delete") lines.push(`L${c.lineNumber} - ${c.content}`);
      else lines.push(`R${c.newLineNumber}   ${c.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds structured XML elements of diffs for LLM prompt injection.
 */
export function buildConcatenatedDiffsXML(diffs: ParsedFileDiff[]): string {
  return diffs
    .map(
      (d) => `<file_diff path="${d.path}" type="${d.type}">
${d.promptDiff}
</file_diff>`,
    )
    .join("\n\n");
}
