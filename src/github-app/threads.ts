import type { Octokit } from "@octokit/rest";
import { parseFindingMarker } from "../domain/relocator.js";
import type { OpenFinding } from "../domain/session.js";
import type { ResolvedFinding } from "../runtime/engine.js";

/** An open finding together with the GitHub review thread that holds it. */
export interface ThreadFinding extends OpenFinding {
  threadId: string;
  /** REST id of the thread's first comment, to reply under it. */
  commentId: number;
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          path: string;
          line: number | null;
          originalLine: number | null;
          comments: {
            nodes: { databaseId: number; body: string; author: { login: string } | null }[];
          };
        }[];
      };
    };
  };
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line originalLine
          comments(first: 1) { nodes { databaseId body author { login } } }
        }
      }
    }
  }
}`;

// Head of a finding comment written by DiffAnchorRelocator: **[P3]** [LOGIC] **Title**
const FINDING_HEAD = /\*\*\[(P[0-4])\]\*\* \[[A-Z]+\] \*\*(.+?)\*\*/;

/**
 * Unresolved review threads started by this App, as findings the agent may resolve. Threads from
 * before finding ids were tagged get an id derived from their first comment.
 */
export async function loadOpenFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  botLogin: string,
): Promise<ThreadFinding[]> {
  // GraphQL names bots without the "[bot]" suffix that REST uses.
  const isBot = (login?: string) => login === botLogin || `${login}[bot]` === botLogin;
  const findings: ThreadFinding[] = [];
  let after: string | null = null;
  do {
    const page: ThreadsPage = await octokit.graphql<ThreadsPage>(THREADS_QUERY, {
      owner,
      repo,
      pr: pullNumber,
      after,
    });
    const threads = page.repository.pullRequest.reviewThreads;
    for (const t of threads.nodes) {
      const first = t.comments.nodes[0];
      if (t.isResolved || !first || !isBot(first.author?.login)) continue;
      const head = FINDING_HEAD.exec(first.body);
      if (!head) continue;
      findings.push({
        id: parseFindingMarker(first.body) ?? `c${first.databaseId}`,
        severity: head[1],
        path: t.path,
        line: t.line ?? t.originalLine ?? undefined,
        title: head[2],
        threadId: t.id,
        commentId: first.databaseId,
      });
    }
    after = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (after);
  return findings;
}

/** Replies with the reason in each fixed finding's thread, then resolves the thread. */
export async function resolveFindingThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  commit: string,
  open: ThreadFinding[],
  resolved: ResolvedFinding[],
): Promise<number> {
  let count = 0;
  for (const r of resolved) {
    const finding = open.find((f) => f.id === r.id);
    if (!finding) continue;
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: pullNumber,
      comment_id: finding.commentId,
      body: `Fixed in ${commit.slice(0, 7)}: ${r.reason}`,
    });
    await octokit.graphql(
      `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`,
      { id: finding.threadId },
    );
    count++;
  }
  return count;
}
