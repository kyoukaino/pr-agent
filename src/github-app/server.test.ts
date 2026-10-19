import * as crypto from "node:crypto";
import { describe, it, expect } from "vite-plus/test";
import { replyJobFor, verifyWebhookSignature } from "./server.js";

describe("verifyWebhookSignature", () => {
  const body = Buffer.from('{"action":"opened"}');
  const good = `sha256=${crypto.createHmac("sha256", "s3cret").update(body).digest("hex")}`;

  it("accepts the correct signature", () => {
    expect(verifyWebhookSignature("s3cret", body, good)).toBe(true);
  });

  it("rejects wrong or malformed signatures without throwing", () => {
    expect(verifyWebhookSignature("s3cret", body, "sha256=abc")).toBe(false); // length mismatch used to throw
    expect(verifyWebhookSignature("other", body, good)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, undefined)).toBe(false);
  });
});

describe("replyJobFor", () => {
  const event = (comment: Record<string, unknown>) => ({
    action: "created",
    installation: { id: 7 },
    repository: { name: "r", owner: { login: "o" } },
    pull_request: { number: 1, head: { sha: "abc" }, user: { login: "author" } },
    comment: {
      id: 900,
      in_reply_to_id: 500,
      body: "This is intended.",
      author_association: "NONE",
      user: { login: "author", type: "User" },
      ...comment,
    },
  });

  it("answers the PR author and repository members replying in a thread", () => {
    expect(replyJobFor(event({}), "deepseek-flash")).toMatchObject({
      jobId: "reply_o_r_pr1_900",
      commit_id: "abc",
      reply: { commentId: 900, rootCommentId: 500, author: "author", body: "This is intended." },
    });
    const member = event({ author_association: "MEMBER", user: { login: "m", type: "User" } });
    expect(replyJobFor(member, "deepseek-flash")?.reply?.author).toBe("m");
  });

  it("ignores new threads, bots (the App's own replies) and outsiders", () => {
    expect(replyJobFor(event({ in_reply_to_id: undefined }), "m")).toBeUndefined();
    expect(replyJobFor(event({ user: { login: "x[bot]", type: "Bot" } }), "m")).toBeUndefined();
    expect(replyJobFor(event({ user: { login: "stranger", type: "User" } }), "m")).toBeUndefined();
  });
});
