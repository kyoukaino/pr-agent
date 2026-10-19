import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";

/**
 * Direct mapping to GitHub REST API:
 * POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
 * API Version: 2026-03-10 / current
 */
export type GitHubCreateReviewParams =
  RestEndpointMethodTypes["pulls"]["createReview"]["parameters"];

export type GitHubReviewComment = NonNullable<GitHubCreateReviewParams["comments"]>[number];

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type DefectSeverity = "P0" | "P1" | "P2" | "P3" | "P4";

export type DefectCategory = "security" | "bug" | "performance" | "maintainability" | "logic";

/**
 * Normalized internal representation of an emitted review finding.
 */
export interface EmittedComment {
  id: string;
  path: string;
  line: number;
  start_line?: number;
  side: "LEFT" | "RIGHT";
  start_side?: "LEFT" | "RIGHT";
  subject_type?: "line" | "file";
  severity: DefectSeverity;
  category: DefectCategory;
  title: string;
  body: string;
  suggested_code?: string;
  thinking?: string;
}

/**
 * GitHub Review Payload produced by the PR-Agent
 */
export interface PRAgentReviewPayload extends GitHubCreateReviewParams {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: GitHubReviewComment[];
}
