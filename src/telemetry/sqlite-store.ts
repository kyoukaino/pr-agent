import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { RunTraceManifest } from "../runtime/trace.js";

export interface StoredReview {
  id: string;
  repo: string;
  pr_number: number;
  commit_id: string;
  created_at: string;
  status: string;
  event: string;
  duration_ms: number | null;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  raw_diff: string;
  comments_json: string;
  metrics_json?: string;
}

export interface StoredSpan {
  id: string;
  review_id: string;
  parent_id?: string | null;
  name: string;
  kind: string; // AGENT, LLM, TOOL
  duration_ms: number | null;
  input_preview?: string;
  output_preview?: string;
  tokens: number;
  created_at: string;
  attributes_json?: string;
}

export class SqliteTraceStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const targetPath = dbPath || path.join(process.cwd(), ".pr-agent", "traces.db");

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(targetPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        repo TEXT,
        pr_number INTEGER,
        commit_id TEXT,
        created_at TEXT,
        status TEXT,
        event TEXT,
        duration_ms INTEGER,
        total_tokens INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost_usd REAL,
        raw_diff TEXT,
        comments_json TEXT,
        metrics_json TEXT
      );

      CREATE TABLE IF NOT EXISTS spans (
        id TEXT PRIMARY KEY,
        review_id TEXT,
        parent_id TEXT,
        name TEXT,
        kind TEXT,
        duration_ms INTEGER,
        input_preview TEXT,
        output_preview TEXT,
        tokens INTEGER,
        created_at TEXT,
        attributes_json TEXT,
        FOREIGN KEY(review_id) REFERENCES reviews(id)
      );

      CREATE INDEX IF NOT EXISTS idx_spans_review_id ON spans(review_id);
      CREATE INDEX IF NOT EXISTS idx_spans_parent_id ON spans(parent_id);
    `);
    // Databases created before cost accounting moved to USD carry a cost_rmb column holding
    // placeholder estimates; drop those values rather than mislabel them.
    const columns = this.db.prepare(`PRAGMA table_info(reviews)`).all() as { name: string }[];
    if (columns.some((c) => c.name === "cost_rmb")) {
      this.db.exec(
        `ALTER TABLE reviews DROP COLUMN cost_rmb; ALTER TABLE reviews ADD COLUMN cost_usd REAL;`,
      );
    }
  }

  public insertReview(review: StoredReview): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO reviews (
        id, repo, pr_number, commit_id, created_at, status, event,
        duration_ms, total_tokens, prompt_tokens, completion_tokens,
        cost_usd, raw_diff, comments_json, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      review.id,
      review.repo,
      review.pr_number,
      review.commit_id,
      review.created_at,
      review.status,
      review.event,
      review.duration_ms,
      review.total_tokens,
      review.prompt_tokens,
      review.completion_tokens,
      review.cost_usd,
      review.raw_diff,
      review.comments_json,
      review.metrics_json || "{}",
    );
  }

  public insertSpan(span: StoredSpan): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO spans (
        id, review_id, parent_id, name, kind, duration_ms,
        input_preview, output_preview, tokens, created_at, attributes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      span.id,
      span.review_id,
      span.parent_id || null,
      span.name,
      span.kind,
      span.duration_ms,
      span.input_preview || "",
      span.output_preview || "",
      span.tokens,
      span.created_at,
      span.attributes_json || "{}",
    );
  }

  public hasReview(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM reviews WHERE id = ?`).get(id) !== undefined;
  }

  /**
   * Stores a review and the span tree derived from its run trace. Every value comes from the run
   * itself; fields the trace does not carry (older traces) are stored as NULL rather than guessed.
   */
  public recordRun(review: StoredReview, trace?: RunTraceManifest | null): void {
    this.insertReview(review);
    this.db.prepare(`DELETE FROM spans WHERE review_id = ?`).run(review.id);

    const rootSpanId = `span_${review.id}_root`;
    this.insertSpan({
      id: rootSpanId,
      review_id: review.id,
      parent_id: null,
      name: `PRAgent.reviewPR (PR #${review.pr_number})`,
      kind: "AGENT",
      duration_ms: review.duration_ms,
      tokens: review.total_tokens,
      created_at: review.created_at,
      input_preview: `PR #${review.pr_number} in ${review.repo} (${review.commit_id.slice(0, 7)})`,
      output_preview: `Verdict: ${review.event}`,
      attributes_json: JSON.stringify({
        repo: review.repo,
        pr_number: review.pr_number,
        commit_id: review.commit_id,
      }),
    });

    (trace?.turns ?? []).forEach((turn, idx) => {
      const turnSpanId = `span_${review.id}_turn_${idx + 1}`;
      const createdAt = turn.startedAt ?? trace!.startTime;
      this.insertSpan({
        id: turnSpanId,
        review_id: review.id,
        parent_id: rootSpanId,
        name: `ReAct Turn #${turn.turnNumber} [${turn.subtaskKey}]`,
        kind: "LLM",
        duration_ms: turn.durationMs ?? null,
        tokens: turn.usage?.totalTokens || 0,
        created_at: createdAt,
        input_preview:
          turn.requestMessages?.[turn.requestMessages.length - 1]?.content?.slice(0, 200) || "",
        output_preview: (turn.responseContent || turn.reasoningContent || "").slice(0, 200),
        attributes_json: JSON.stringify({
          subtaskKey: turn.subtaskKey,
          reasoningContent: turn.reasoningContent || "",
          responseContent: turn.responseContent || "",
          toolCalls: turn.toolCalls || [],
          toolResults: turn.toolResults || [],
          usage: turn.usage || {},
        }),
      });

      for (const tc of turn.toolCalls ?? []) {
        const tr = turn.toolResults?.find((r) => r.toolCallId === tc.id);
        this.insertSpan({
          id: `span_${review.id}_tool_${tc.id}`,
          review_id: review.id,
          parent_id: turnSpanId,
          name: `Tool: ${tc.function?.name || "tool"}`,
          kind: "TOOL",
          duration_ms: tr?.durationMs ?? null,
          tokens: 0,
          created_at: createdAt,
          input_preview: tc.function?.arguments || "",
          output_preview: tr?.result?.slice(0, 300) || "",
          attributes_json: JSON.stringify({
            toolName: tc.function?.name,
            arguments: tc.function?.arguments,
            result: tr?.result,
          }),
        });
      }
    });
  }

  public getReviews(): StoredReview[] {
    const stmt = this.db.prepare(`SELECT * FROM reviews ORDER BY created_at DESC`);
    return stmt.all() as unknown as StoredReview[];
  }

  public getReviewById(id: string): { review: StoredReview; spans: StoredSpan[] } | null {
    const reviewStmt = this.db.prepare(`SELECT * FROM reviews WHERE id = ?`);
    const review = reviewStmt.get(id) as unknown as StoredReview | undefined;
    if (!review) return null;

    const spansStmt = this.db.prepare(
      `SELECT * FROM spans WHERE review_id = ? ORDER BY created_at ASC`,
    );
    const spans = spansStmt.all(id) as unknown as StoredSpan[];

    return { review, spans };
  }

  /** Aggregates over stored runs. Quality metrics (precision/recall) need ground truth and live in bench/. */
  public getGlobalMetrics(): {
    totalReviews: number;
    totalTokens: number;
    totalCostUsd: number;
    avgDurationMs: number;
    totalComments: number;
  } {
    const res = this.db
      .prepare(
        `SELECT
          COUNT(*) as totalReviews,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(cost_usd), 0) as totalCostUsd,
          COALESCE(AVG(duration_ms), 0) as avgDurationMs
        FROM reviews`,
      )
      .get() as {
      totalReviews: number;
      totalTokens: number;
      totalCostUsd: number;
      avgDurationMs: number;
    };

    let totalComments = 0;
    for (const r of this.getReviews()) {
      try {
        const comments = JSON.parse(r.comments_json || "[]");
        totalComments += Array.isArray(comments) ? comments.length : 0;
      } catch {
        // ignore
      }
    }

    return {
      totalReviews: res.totalReviews || 0,
      totalTokens: res.totalTokens || 0,
      totalCostUsd: Number((res.totalCostUsd || 0).toFixed(4)),
      avgDurationMs: Math.round(res.avgDurationMs || 0),
      totalComments,
    };
  }

  /**
   * Backfills runs recorded on disk (.pr-agent/sessions + traces) that are not in the database yet,
   * e.g. runs from before the store existed or runs that crashed before writing their row.
   * Existing rows are never overwritten: live runs store the authoritative record (with diff).
   */
  public syncFromDisk(baseDir = process.cwd()): number {
    const sessionsDir = path.join(baseDir, ".pr-agent", "sessions");
    const tracesDir = path.join(baseDir, ".pr-agent", "traces");
    if (!fs.existsSync(sessionsDir)) return 0;

    let imported = 0;
    for (const file of fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))) {
      const runId = file.replace(".jsonl", "");
      if (this.hasReview(runId)) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let runStart: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let runEnd: any = null;
      const comments: unknown[] = [];
      for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "RUN_START" && !runStart) runStart = event;
          if (event.type === "COMMENT_EMITTED") comments.push(event.data.comment);
          if (event.type === "RUN_END") runEnd = event;
        } catch {
          // ignore corrupted line
        }
      }
      if (!runStart) continue;

      let trace: RunTraceManifest | null = null;
      const traceFile = path.join(tracesDir, `trace-${runId}.json`);
      if (fs.existsSync(traceFile)) {
        try {
          trace = JSON.parse(fs.readFileSync(traceFile, "utf-8")) as RunTraceManifest;
        } catch {
          trace = null;
        }
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let costUsd = 0;
      for (const turn of trace?.turns ?? []) {
        promptTokens += turn.usage?.promptTokens || 0;
        completionTokens += turn.usage?.completionTokens || 0;
        costUsd += turn.usage?.costUsd || 0;
      }
      const durationMs =
        runEnd && runStart ? Date.parse(runEnd.timestamp) - Date.parse(runStart.timestamp) : null;

      this.recordRun(
        {
          id: runId,
          repo: `${runStart.data.owner}/${runStart.data.repo}`,
          pr_number: runStart.data.pull_number,
          commit_id: runStart.data.commit_id,
          created_at: runStart.timestamp,
          status: runEnd ? "completed" : "incomplete",
          event: runEnd?.data?.finalEvent ?? "UNKNOWN",
          duration_ms: durationMs,
          total_tokens: runEnd?.data?.totalTokensUsed ?? promptTokens + completionTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          cost_usd: runEnd?.data?.costUsd ?? costUsd,
          raw_diff: "", // the session log does not keep the diff
          comments_json: JSON.stringify(comments),
          metrics_json: JSON.stringify({
            model: runStart.data.model ?? null,
            groupsCount: runStart.data.groupsCount ?? null,
            turnsCount: trace?.turns.length ?? null,
            backfilled: true,
          }),
        },
        trace,
      );
      imported++;
    }
    return imported;
  }
}
