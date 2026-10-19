import type { ChatMessage } from "../runtime/types.js";
import type { ParsedFileDiff } from "./diff-parser.js";

/** A finding posted by an earlier review that is still open on the PR and can be resolved. */
export interface OpenFinding {
  id: string;
  severity?: string;
  path: string;
  line?: number;
  title: string;
}

export interface SessionGroup {
  label: string;
  /** Files whose changes this conversation reviews; new changes to them are routed here. */
  paths: string[];
  messages: ChatMessage[];
}

/**
 * The review conversations of one PR, kept so later events (new commits) continue them instead of
 * starting over: the agent keeps what it read, verified and reported. GitHub stays the source of
 * truth; a session that no longer matches it is discarded and the review starts fresh.
 */
export interface ReviewSession {
  version: 1;
  model: string;
  /** Head commit the conversations last reviewed. */
  reviewedCommit: string;
  groups: SessionGroup[];
}

/**
 * Routes changed files to the conversation that reviewed them; files new to the PR go to the last
 * group. Returns, per group index, the files it receives.
 */
export function routeToGroups(
  groups: SessionGroup[],
  files: ParsedFileDiff[],
): Map<number, ParsedFileDiff[]> {
  const routed = new Map<number, ParsedFileDiff[]>();
  for (const file of files) {
    const owner = groups.findIndex((g) => g.paths.includes(file.path));
    const index = owner >= 0 ? owner : groups.length - 1;
    routed.set(index, [...(routed.get(index) ?? []), file]);
  }
  return routed;
}
