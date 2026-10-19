import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { CheckpointStore } from "./checkpoint.js";
import type { EmittedComment } from "../domain/github-types.js";

const comment = (id: string): EmittedComment => ({
  id,
  path: "a.ts",
  line: 1,
  side: "RIGHT",
  severity: "P2",
  category: "bug",
  title: id,
  body: "",
});

describe("CheckpointStore resume", () => {
  it("skips only completed subtasks and drops comments of interrupted ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-ckpt-"));
    const store = new CheckpointStore(dir);
    store.appendEvent("r1", "RUN_START", {});
    store.appendEvent("r1", "COMMENT_EMITTED", { subtaskKey: "g1", comment: comment("c1") });
    store.appendEvent("r1", "SUBTASK_DONE", {
      subtaskKey: "g1",
      completed: true,
      usage: { promptTokens: 900, completionTokens: 100, costUsd: 0.1 },
    });
    store.appendEvent("r1", "COMMENT_EMITTED", { subtaskKey: "g2", comment: comment("c2") });
    store.appendEvent("r1", "SUBTASK_DONE", {
      subtaskKey: "g2",
      completed: false,
      usage: { promptTokens: 2200, completionTokens: 300, costUsd: 0.3 },
    });

    const state = await store.loadResumeState("r1");
    expect([...state!.completedSubtasks]).toEqual(["g1"]);
    expect(state!.accumulatedComments.map((c) => c.id)).toEqual(["c1"]);
    expect(state!.usage).toEqual({ promptTokens: 2200, completionTokens: 300, costUsd: 0.3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
