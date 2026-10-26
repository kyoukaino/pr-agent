import type { DiffHunkRange, ParsedFileDiff } from "./diff-parser.js";
import { diffFilePath, hunkSpan, type ReviewMode } from "./workspace.js";

/** A mounted file whose hunks were not all read during the review. */
export interface UnreadFile {
  path: string;
  mode: ReviewMode;
  totalHunks: number;
  /** Anchor spans of the hunks no read_file call returned in full. */
  unread: string[];
}

export interface CoverageSummary {
  /** Files whose diff was in a group prompt. */
  inlineFiles: number;
  /** Files reviewed from a diff mount (oversized or on demand). */
  mountedFiles: number;
  mountedHunks: number;
  mountedHunksRead: number;
  unreadFiles: UnreadFile[];
}

interface Tracked {
  path: string;
  mode: ReviewMode;
  hunks: DiffHunkRange[];
  reads: [number, number][];
}

function covered(reads: [number, number][], start: number, end: number): boolean {
  let next = start;
  for (const [s, e] of [...reads].sort((a, b) => a[0] - b[0])) {
    if (s > next) break;
    next = Math.max(next, e + 1);
    if (next > end) return true;
  }
  return next > end;
}

/**
 * Review coverage of diffs the agent had to read from a mount. An inline diff is covered by being
 * in the prompt; a mounted one only hunk by hunk, as read_file returns it. A hunk counts as read
 * once its whole line span (header included) was returned, possibly across several calls.
 */
export class CoverageTracker {
  private tracked = new Map<string, Tracked>();
  private inline = new Set<string>();

  public trackInline(file: ParsedFileDiff): void {
    this.inline.add(file.path);
  }

  public trackMounted(mount: string, file: ParsedFileDiff, mode: ReviewMode): void {
    this.tracked.set(diffFilePath(mount, file.path), {
      path: file.path,
      mode,
      hunks: file.hunkRanges,
      reads: [],
    });
  }

  /** A read_file result; reads of anything but a tracked diff are ignored. */
  public recordRead(readPath: string, startLine: number, endLine: number): void {
    if (endLine < startLine) return;
    this.tracked.get(readPath)?.reads.push([startLine, endLine]);
  }

  public summary(): CoverageSummary {
    let mountedHunks = 0;
    let mountedHunksRead = 0;
    const unreadFiles: UnreadFile[] = [];
    for (const t of this.tracked.values()) {
      const unread = t.hunks.filter((h) => !covered(t.reads, h.promptStart, h.promptEnd));
      mountedHunks += t.hunks.length;
      mountedHunksRead += t.hunks.length - unread.length;
      if (unread.length > 0) {
        unreadFiles.push({
          path: t.path,
          mode: t.mode,
          totalHunks: t.hunks.length,
          unread: unread.map(hunkSpan),
        });
      }
    }
    return {
      inlineFiles: this.inline.size,
      mountedFiles: this.tracked.size,
      mountedHunks,
      mountedHunksRead,
      unreadFiles: unreadFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
}
