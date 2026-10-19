import type { GitHubReviewComment, EmittedComment } from "./github-types.js";
import type { ParsedPRDiff, ParsedFileDiff, DiffHunkRange } from "./diff-parser.js";

/** Max distance (lines) from a hunk edge at which an out-of-hunk comment is clamped onto the hunk. */
const CLAMP_DISTANCE = 15;

/**
 * Result of anchoring one finding. `inline` comments go into the review's `comments` array; findings
 * that cannot be anchored to a diff line are returned as `unanchored` and belong in the review body,
 * because POST /pulls/{n}/reviews rejects (HTTP 422) any comment without a valid line in the diff,
 * which would fail the entire review.
 */
export type AnchorResult =
  | { kind: "inline"; comment: GitHubReviewComment }
  | { kind: "unanchored"; reason: string; body: string };

function hunkRange(h: DiffHunkRange, side: "LEFT" | "RIGHT"): [number, number] | null {
  const start = side === "RIGHT" ? h.newStart : h.oldStart;
  const count = side === "RIGHT" ? h.newLines : h.oldLines;
  return count > 0 ? [start, start + count - 1] : null;
}

export class DiffAnchorRelocator {
  private fileMap: Map<string, ParsedFileDiff>;

  constructor(prDiff: ParsedPRDiff) {
    this.fileMap = prDiff.fileMap;
  }

  /**
   * Validates and relocates an emitted comment so it is accepted by the GitHub Review API.
   */
  public anchor(comment: EmittedComment): AnchorResult {
    const fileDiff = this.fileMap.get(comment.path);
    if (!fileDiff) {
      return {
        kind: "unanchored",
        reason: "file not in PR diff",
        body: this.formatCommentBody(comment),
      };
    }

    const side = comment.side || "RIGHT";
    const ranges = fileDiff.hunkRanges
      .map((h) => hunkRange(h, side))
      .filter((r): r is [number, number] => r !== null);
    if (ranges.length === 0) {
      return {
        kind: "unanchored",
        reason:
          side === "RIGHT" ? "no added/context lines on the new side" : "no lines on the old side",
        body: this.formatCommentBody(comment),
      };
    }

    const target = comment.line;
    const containing = ranges.find(([s, e]) => target >= s && target <= e);
    if (containing) {
      const startLine =
        comment.start_line !== undefined &&
        comment.start_line >= containing[0] &&
        comment.start_line < target
          ? comment.start_line
          : undefined; // multi-line ranges must stay inside one hunk on one side
      return {
        kind: "inline",
        comment: {
          path: comment.path,
          line: target,
          side,
          ...(startLine !== undefined ? { start_line: startLine, start_side: side } : {}),
          body: this.formatCommentBody(comment),
        },
      };
    }

    // Outside every hunk: clamp onto the nearest hunk edge when close enough.
    let best: { line: number; dist: number } | null = null;
    for (const [s, e] of ranges) {
      const line = target < s ? s : e;
      const dist = Math.abs(target - line);
      if (!best || dist < best.dist) best = { line, dist };
    }
    if (best && best.dist <= CLAMP_DISTANCE) {
      return {
        kind: "inline",
        comment: {
          path: comment.path,
          line: best.line,
          side,
          body: `> **[Note: Originally targeted line ${target}, anchored to nearest modified diff hunk; suggestion omitted]**\n\n${this.formatCommentBody(comment, false)}`,
        },
      };
    }

    return {
      kind: "unanchored",
      reason: `line ${target} is outside the diff hunks`,
      body: this.formatCommentBody(comment),
    };
  }

  /** A suggestion block replaces the anchored lines, so it is dropped when the anchor was moved. */
  public formatCommentBody(comment: EmittedComment, includeSuggestion = true): string {
    const badge = `**[${comment.severity}]** [${comment.category.toUpperCase()}]`;
    let body = `${badge} **${comment.title}**\n\n${comment.body}`;
    if (includeSuggestion && comment.suggested_code) {
      body += `\n\n\`\`\`suggestion\n${comment.suggested_code}\n\`\`\``;
    }
    return body;
  }
}
