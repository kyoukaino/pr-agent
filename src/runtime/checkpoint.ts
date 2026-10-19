import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { EmittedComment } from "../domain/github-types.js";
import type { TaskState } from "./types.js";

export interface CheckpointEvent {
  type: "RUN_START" | "COMMENT_EMITTED" | "SUBTASK_DONE" | "RUN_END";
  timestamp: string;
  runId: string;
  data: Record<string, unknown>;
}

export interface ResumeState {
  runId: string;
  completedSubtasks: Set<string>;
  accumulatedComments: EmittedComment[];
  /** Usage of the interrupted run, carried over so the resumed run stays within the same budget. */
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
  lastState: TaskState;
}

export class CheckpointStore {
  private baseDir: string;

  constructor(baseDir = ".pr-agent/sessions") {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getSessionPath(runId: string): string {
    return path.join(this.baseDir, `${runId}.jsonl`);
  }

  public appendEvent(
    runId: string,
    type: CheckpointEvent["type"],
    data: Record<string, unknown>,
  ): void {
    const event: CheckpointEvent = {
      type,
      timestamp: new Date().toISOString(),
      runId,
      data,
    };
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(this.getSessionPath(runId), line, "utf-8");
  }

  public async loadResumeState(runId: string): Promise<ResumeState | null> {
    const sessionFile = this.getSessionPath(runId);
    if (!fs.existsSync(sessionFile)) {
      return null;
    }

    const state: ResumeState = {
      runId,
      completedSubtasks: new Set<string>(),
      accumulatedComments: [],
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      lastState: "PENDING",
    };

    const fileStream = fs.createReadStream(sessionFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const commentsBySubtask = new Map<string, EmittedComment[]>();

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as CheckpointEvent;
        switch (ev.type) {
          case "SUBTASK_DONE":
            // Only fully completed groups are skipped on resume; interrupted ones are re-run.
            if (ev.data.subtaskKey && ev.data.completed === true) {
              state.completedSubtasks.add(String(ev.data.subtaskKey));
            }
            // usage is the run's cumulative total at that point; the last event wins.
            if (ev.data.usage && typeof ev.data.usage === "object") {
              state.usage = { ...(ev.data.usage as ResumeState["usage"]) };
            }
            break;
          case "COMMENT_EMITTED":
            if (ev.data.comment) {
              const key = String(ev.data.subtaskKey ?? "");
              if (!commentsBySubtask.has(key)) commentsBySubtask.set(key, []);
              commentsBySubtask.get(key)!.push(ev.data.comment as EmittedComment);
            }
            break;
          case "RUN_END":
            state.lastState = (ev.data.finalState as TaskState) || "COMPLETED";
            break;
        }
      } catch {
        // Skip corrupted line
      }
    }

    // Comments from groups that will be re-run would otherwise be emitted twice.
    for (const key of state.completedSubtasks) {
      state.accumulatedComments.push(...(commentsBySubtask.get(key) ?? []));
    }

    return state;
  }
}
