export type DatasetName = "aacr" | "martian";

/** A ground-truth review comment, normalized across datasets. */
export interface ReferenceComment {
  text: string;
  /** AACR has file/line anchors; Martian golden comments are PR-level only. */
  path?: string;
  startLine?: number;
  endLine?: number;
  side?: "left" | "right";
  /** AACR: Code Defect / Security Vulnerability / ...; Martian: bug / security / style / ... */
  category?: string;
  severity?: string;
}

/** One PR revision to review, normalized across datasets. */
export interface BenchInstance {
  id: string;
  dataset: DatasetName;
  /** owner/name of the repository the commits live in. */
  repo: string;
  prNumber: number;
  prUrl: string;
  /** AACR provides both commits; Martian ones are resolved from the GitHub PR at runtime. */
  baseCommit?: string;
  headCommit?: string;
  references: ReferenceComment[];
  meta?: Record<string, unknown>;
}

/** A finding produced by the agent, in the shape the judges consume. */
export interface GeneratedComment {
  path: string;
  startLine?: number;
  endLine: number;
  severity: string;
  category: string;
  text: string;
}

/** Persisted per-instance output of the review stage. */
export interface ReviewRecord {
  instanceId: string;
  /**
   * ok: reviewed. error: the agent failed during the review; scored as a review with no comments.
   * unavailable: the instance could not be prepared (dataset commits gone from GitHub, persistent
   * GitHub / git failures after retries); excluded from scoring and listed in metrics.json.
   */
  status: "ok" | "error" | "unavailable";
  error?: string;
  baseCommit?: string;
  headCommit?: string;
  diffFiles?: number;
  diffBytes?: number;
  model: string;
  durationMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  agentRunId?: string;
  /** Diff files the agent did not review (generated, binary). */
  skippedFiles?: { path: string; reason: string }[];
  /** How much of the diffs reviewed from a mount (oversized, on demand) the agent read. */
  coverage?: {
    inlineFiles: number;
    mountedFiles: number;
    mountedHunks: number;
    mountedHunksRead: number;
  };
  /** How each file group ended; a stopReason other than "none" means the group was cut short. */
  groups?: { group: string; files: number; stopReason: string; costUsd: number; error?: string }[];
  comments: GeneratedComment[];
}
