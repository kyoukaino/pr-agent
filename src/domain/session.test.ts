import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { AgentRuntimeEngine } from "../runtime/engine.js";
import type { ChatMessage } from "../runtime/types.js";
import type { DeepSeekLLMClient, LLMResponse } from "../llm/client.js";
import { parseGitDiff } from "./diff-parser.js";
import { buildFollowUpMessage } from "./prompt.js";
import { routeToGroups, type SessionGroup } from "./session.js";
import { PRSessionStore } from "../github-app/session-store.js";

const usage = {
  promptTokens: 10,
  completionTokens: 1,
  totalTokens: 11,
  cacheHitTokens: 0,
  costUsd: 0,
};
const call = (name: string, args: object, id: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** Scripted model: plays the given turns in order and records every request it receives. */
function scriptedClient(turns: LLMResponse["toolCalls"][], requests: ChatMessage[][]) {
  let n = 0;
  return {
    model: "test-model",
    chatCompletion: async (messages: ChatMessage[]): Promise<LLMResponse> => {
      requests.push(messages.map((m) => ({ ...m })));
      return { content: "", toolCalls: turns[n++], usage };
    },
  } as unknown as DeepSeekLLMClient;
}

describe("continuing a review conversation", () => {
  it("appends the follow-up to the earlier conversation and resolves fixed findings", async () => {
    const requests: ChatMessage[][] = [];
    const client = scriptedClient(
      [
        [call("task_done", { state: "DONE" }, "a")], // first review
        [
          call("resolve_finding", { id: "fabc123", reason: "now guarded" }, "b"),
          call("resolve_finding", { id: "fnope", reason: "?" }, "c"), // not open: rejected
        ],
        [call("task_done", { state: "DONE" }, "d")],
      ],
      requests,
    );
    const engine = new AgentRuntimeEngine({
      runId: "session-test",
      repoDir: os.tmpdir(),
      llmClient: client,
      openFindingIds: ["fabc123"],
    });

    const first = await engine.executeSubtask("g", [
      { role: "system", content: "system" },
      { role: "user", content: "review commit 1" },
    ]);
    const followUp: ChatMessage = { role: "user", content: "commit 2 pushed" };
    const second = await engine.executeSubtask("g", [...first.messages, followUp]);

    // The second review sees the first conversation unchanged as its prefix (prompt cache hit).
    expect(requests[1].slice(0, first.messages.length)).toEqual(first.messages);
    expect(requests[1][first.messages.length]).toEqual(followUp);
    expect(second.resolved).toEqual([{ id: "fabc123", reason: "now guarded" }]);
    const toolReplies = second.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolReplies.some((c) => c.includes("'fnope' is not an open finding"))).toBe(true);
  });
});

describe("follow-up message", () => {
  it("names the changed files, the open findings and the new diff", () => {
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`);
    const msg = buildFollowUpMessage({
      commit: "c10201f0000",
      sinceCommit: "36fb1e40000",
      diffs: diff.files,
      openFindings: [{ id: "fabc123", severity: "P3", path: "a.ts", line: 1, title: "Unused a" }],
      confirmedComments: [],
    });
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("from 36fb1e4 (your last review) to c10201f");
    expect(msg.content).toContain("may be outdated: a.ts");
    expect(msg.content).toContain("- id=fabc123 [P3] a.ts:1: Unused a");
    expect(msg.content).toContain("<changes_since_last_review>");
    expect(msg.content).toContain("const b = 2;");
  });
});

describe("routeToGroups", () => {
  it("sends changes to the conversation that reviewed the file, new files to the last one", () => {
    const groups: SessionGroup[] = [
      { label: "part 1/2", paths: ["a.ts"], messages: [] },
      { label: "part 2/2", paths: ["b.ts"], messages: [] },
    ];
    const files = ["b.ts", "new.ts", "a.ts"].map(
      (p) =>
        parseGitDiff(`diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`)
          .files[0],
    );
    const routed = routeToGroups(groups, files);
    expect(routed.get(0)?.map((f) => f.path)).toEqual(["a.ts"]);
    expect(routed.get(1)?.map((f) => f.path)).toEqual(["b.ts", "new.ts"]);
  });
});

describe("PRSessionStore", () => {
  it("saves, loads and deletes a PR's session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-sessions-"));
    const store = new PRSessionStore(dir);
    const session = {
      version: 1 as const,
      model: "deepseek-flash",
      reviewedCommit: "abc",
      groups: [{ label: "all changed files", paths: ["a.ts"], messages: [] }],
    };
    expect(store.load("o", "r", 1)).toBeUndefined();
    store.save("o", "r", 1, session);
    expect(store.load("o", "r", 1)).toEqual(session);
    store.delete("o", "r", 1);
    expect(store.load("o", "r", 1)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("answering an author's reply", () => {
  it("records the answer only when a reply is being answered", async () => {
    const requests: ChatMessage[][] = [];
    const turns = [
      [
        call("reply_to_author", { message: "You're right, it is guarded." }, "r1"),
        call("resolve_finding", { id: "fabc123", reason: "guarded by caller" }, "r2"),
        call("task_done", { state: "DONE" }, "r3"),
      ],
    ];
    const answering = new AgentRuntimeEngine({
      runId: "reply-test",
      repoDir: os.tmpdir(),
      llmClient: scriptedClient(turns, requests),
      openFindingIds: ["fabc123"],
      answeringReply: true,
    });
    const res = await answering.executeSubtask("g", [{ role: "user", content: "reply" }]);
    expect(res.replies).toEqual(["You're right, it is guarded."]);
    expect(res.resolved.map((r) => r.id)).toEqual(["fabc123"]);

    const reviewing = new AgentRuntimeEngine({
      runId: "review-test",
      repoDir: os.tmpdir(),
      llmClient: scriptedClient(turns, []),
      openFindingIds: ["fabc123"],
    });
    const review = await reviewing.executeSubtask("g", [{ role: "user", content: "review" }]);
    expect(review.replies).toEqual([]);
    expect(review.messages.some((m) => m.content.includes("no author reply to answer"))).toBe(true);
  });
});
