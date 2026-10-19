import type {
  GitHubCreateReviewParams,
  GitHubReviewComment,
  EmittedComment,
  ReviewEvent,
} from "./github-types.js";
import type { DiffAnchorRelocator } from "./relocator.js";

export interface AssembleReviewOptions {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  comments: EmittedComment[];
  relocator: DiffAnchorRelocator;
  customSummary?: string;
  totalTokensUsed?: number;
  costUsd?: number;
  minSeverityToBlock?: "P0" | "P1" | "P2" | "P3";
  maxCommentsPerReview?: number;
  /** Diff files the agent did not review, listed in the summary so the gap is visible. */
  skippedFiles?: { path: string; reason: string }[];
  /** File groups whose review ended early (LLM failure). */
  incompleteGroups?: string[];
}

interface UnanchoredFinding {
  comment: EmittedComment;
  reason: string;
  body: string;
}

export class ReviewPayloadAssembler {
  public static assemble(options: AssembleReviewOptions): GitHubCreateReviewParams {
    const {
      owner,
      repo,
      pull_number,
      commit_id,
      relocator,
      customSummary,
      totalTokensUsed,
      costUsd,
      minSeverityToBlock = "P1",
      maxCommentsPerReview = 30,
    } = options;

    const boundedComments = options.comments.slice(0, maxCommentsPerReview);
    const droppedCount = options.comments.length - boundedComments.length;

    // 1. Anchor comments; those without a valid diff line go to the summary body (an invalid
    // inline comment would make GitHub reject the whole review with HTTP 422).
    const githubComments: GitHubReviewComment[] = [];
    const unanchored: UnanchoredFinding[] = [];
    for (const c of boundedComments) {
      const res = relocator.anchor(c);
      if (res.kind === "inline") githubComments.push(res.comment);
      else unanchored.push({ comment: c, reason: res.reason, body: res.body });
    }

    // 2. Determine review event based on severity
    const blockSeverities: Record<string, string[]> = {
      P0: ["P0"],
      P1: ["P0", "P1"],
      P2: ["P0", "P1", "P2"],
      P3: ["P0", "P1", "P2", "P3"],
    };
    const targets = blockSeverities[minSeverityToBlock] || ["P0", "P1"];
    const shouldBlock = boundedComments.some((c) => targets.includes(c.severity));
    const hasAnyComments = boundedComments.length > 0;

    let event: ReviewEvent = "APPROVE";
    if (shouldBlock) {
      event = "REQUEST_CHANGES";
    } else if (hasAnyComments) {
      event = "COMMENT";
    }

    // 3. Generate summary markdown body
    const body =
      ReviewPayloadAssembler.buildSummaryBody(
        boundedComments,
        event,
        customSummary,
        totalTokensUsed,
        costUsd,
      ) +
      ReviewPayloadAssembler.buildCoverageNotes(
        unanchored,
        droppedCount,
        options.skippedFiles ?? [],
        options.incompleteGroups ?? [],
      );

    return {
      owner,
      repo,
      pull_number,
      commit_id,
      event,
      body,
      comments: githubComments,
    };
  }

  private static buildCoverageNotes(
    unanchored: UnanchoredFinding[],
    droppedCount: number,
    skippedFiles: { path: string; reason: string }[],
    incompleteGroups: string[],
  ): string {
    let md = "";
    if (unanchored.length > 0) {
      md += `\n### Findings Outside the Diff\n\n`;
      for (const u of unanchored) {
        md += `<details><summary><code>${u.comment.path}:${u.comment.line}</code> (${u.reason})</summary>\n\n${u.body}\n\n</details>\n`;
      }
    }
    if (droppedCount > 0) {
      md += `\n*${droppedCount} additional finding(s) omitted (maxCommentsPerReview).*\n`;
    }
    if (skippedFiles.length > 0) {
      md += `\n### Not Reviewed\n\n`;
      for (const f of skippedFiles) md += `- \`${f.path}\` — ${f.reason}\n`;
    }
    if (incompleteGroups.length > 0) {
      const groups = incompleteGroups.map((g) => `\`${g}\``).join(", ");
      md += `\n> **Review incomplete** for ${groups} (model call failed).\n`;
    }
    return md;
  }

  private static buildSummaryBody(
    comments: EmittedComment[],
    event: ReviewEvent,
    customSummary?: string,
    totalTokensUsed?: number,
    costUsd?: number,
  ): string {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const c of comments) {
      counts[c.severity]++;
    }

    const badgeMap: Record<ReviewEvent, string> = {
      APPROVE: "LGTM (Approved)",
      REQUEST_CHANGES: "Changes Requested (Blockers Found)",
      COMMENT: "Review Comments Provided",
    };

    let md = `## PR-Agent Review Summary: ${badgeMap[event]}\n\n`;

    if (customSummary) {
      md += `${customSummary}\n\n`;
    }

    md += `### Defect Breakdown\n\n`;
    md += `| Severity | Count | Impact |\n`;
    md += `| :--- | :---: | :--- |\n`;
    md += `| **P0 (Blocker)** | ${counts.P0} | Security vulnerabilities, data corruption, crashes |\n`;
    md += `| **P1 (Critical)** | ${counts.P1} | Functional defects, race conditions, memory leaks |\n`;
    md += `| **P2 (Major)** | ${counts.P2} | Missing boundary checks, performance bottlenecks |\n`;
    md += `| **P3 (Minor)** | ${counts.P3} | Maintainability issues, non-blocking logic |\n`;
    md += `| **P4 (Trivial)** | ${counts.P4} | Code readability & style suggestions |\n\n`;

    if (comments.length === 0) {
      md += `*No actionable defects identified. The change looks clean and well-structured!* \n\n`;
    } else {
      md += `### Key Findings Overview\n\n`;
      for (const c of comments) {
        md += `- **[${c.severity}]** \`${c.path}:${c.line}\`: ${c.title}\n`;
      }
      md += `\n`;
    }

    if (typeof totalTokensUsed === "number") {
      const cost = typeof costUsd === "number" ? ` | Cost: $${costUsd.toFixed(4)}` : "";
      md += `\n---\n*Generated by PR-Agent with DeepSeek | Total Tokens: ~${totalTokensUsed.toLocaleString()}${cost}*\n`;
    }

    return md;
  }
}
