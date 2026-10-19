import { describe, it, expect } from "vite-plus/test";
import type { Octokit } from "@octokit/rest";
import { loadOpenFindings, resolveFindingThreads, type ThreadFinding } from "./threads.js";
import { findingMarker } from "../domain/relocator.js";

const thread = (over: Record<string, unknown>, body: string, login = "pr-agent-test") => ({
  id: "T1",
  isResolved: false,
  path: "ci.yml",
  line: 9,
  originalLine: 9,
  comments: { nodes: [{ databaseId: 501, body, author: { login } }] },
  ...over,
});

const findingBody = (title: string, id?: string) =>
  `**[P4]** [DOCUMENTATION] **${title}**\n\nCause...${id ? `\n\n${findingMarker(id)}` : ""}`;

const threadsResponse = (nodes: unknown[]) => async () => ({
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    },
  },
});

describe("open findings from review threads", () => {
  it("keeps the App's unresolved finding threads, with their tagged or derived ids", async () => {
    const tagged = findingBody("Comment overstates guarantee", "fq1w2e3");
    const legacy = findingBody("Untagged legacy");
    const octokit = {
      graphql: threadsResponse([
        thread({}, tagged),
        thread({ id: "T2", isResolved: true }, findingBody("Already resolved", "fdone00")),
        thread({ id: "T3" }, "Looks good to me", "a-human"),
        thread({ id: "T4", line: null, originalLine: 4 }, legacy),
      ]),
    } as unknown as Octokit;

    const open = await loadOpenFindings(octokit, "o", "r", 1, "pr-agent-test[bot]");
    expect(open).toEqual([
      {
        id: "fq1w2e3",
        severity: "P4",
        path: "ci.yml",
        line: 9,
        title: "Comment overstates guarantee",
        threadId: "T1",
        commentId: 501,
        body: tagged,
      },
      {
        id: "c501",
        severity: "P4",
        path: "ci.yml",
        line: 4,
        title: "Untagged legacy",
        threadId: "T4",
        commentId: 501,
        body: legacy,
      },
    ]);
  });
});

describe("resolveFindingThreads", () => {
  const open: ThreadFinding[] = [
    { id: "fa", path: "x", title: "A", threadId: "TA", commentId: 1, body: "**A**" },
    { id: "fb", path: "y", title: "B", threadId: "TB", commentId: 2, body: "**B**" },
  ];
  const resolved = [
    { id: "fb", reason: "the comment now states the real guarantee" },
    { id: "unknown", reason: "-" },
  ];

  it("replies with the reason and resolves only the threads of resolved findings", async () => {
    const log: string[] = [];
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async (p: { comment_id: number; body: string }) =>
            log.push(`reply ${p.comment_id}: ${p.body}`),
        },
      },
      graphql: async (_q: string, vars: { id: string }) => log.push(`resolve ${vars.id}`),
    } as unknown as Octokit;
    const n = await resolveFindingThreads(octokit, "o", "r", 1, "c10201f0000", open, resolved);
    expect(n).toBe(1);
    expect(log).toEqual([
      "reply 2: Fixed in c10201f: the comment now states the real guarantee",
      "resolve TB",
    ]);
  });
});
