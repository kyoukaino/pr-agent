import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";
import { PRAgent } from "../src/index.js";
import { flushTelemetry } from "../src/telemetry/otel.js";
import type { EmittedComment } from "../src/domain/github-types.js";
import { loadDataset, seededShuffle } from "./datasets.js";
import { prepareWorkspace, type RepoMode } from "./workspace.js";
import { BenchJudge, createLimiter } from "./judges.js";
import {
  aggregateAacr,
  aggregateMartian,
  evaluateAacr,
  evaluateMartian,
  type AacrInstanceEval,
  type MartianInstanceEval,
} from "./evaluate.js";
import type { BenchInstance, GeneratedComment, ReviewRecord } from "./types.js";

const program = new Command()
  .name("bench")
  .description("Run PR-Agent on AACR-Bench / Martian and score it with an LLM judge")
  .requiredOption("-d, --dataset <name>", "aacr | martian")
  .option("--stage <stage>", "all | review | eval", "all")
  .option("--run-id <id>", "results directory name (reuse it to resume or re-evaluate)")
  .option("-n, --limit <n>", "evaluate only N instances (after seeded shuffle)")
  .option("--seed <n>", "shuffle seed used with --limit", "42")
  .option("--ids <ids>", "comma-separated instance ids to run")
  .option(
    "--review-model <model>",
    "model used by the agent",
    process.env.BENCH_REVIEW_MODEL || "deepseek-flash",
  )
  .option(
    "--judge-model <model>",
    "model used by the judge",
    process.env.BENCH_JUDGE_MODEL || "deepseek-v4-pro",
  )
  .option(
    "--repo-mode <mode>",
    "checkout (agent tools see the head revision) | diff-only",
    "checkout",
  )
  .option("--max-cost <usd>", "spending cap per PR review in USD (default: agent default)")
  .option("-c, --concurrency <n>", "instances reviewed in parallel", "2")
  .option("--judge-concurrency <n>", "parallel judge calls", "8")
  .option("--force", "redo reviews / evaluations that already have results")
  .option("--trace", "export OpenTelemetry spans to Phoenix during the review stage")
  .parse();

const opts = program.opts<{
  dataset: string;
  stage: "all" | "review" | "eval";
  runId?: string;
  limit?: string;
  seed: string;
  ids?: string;
  reviewModel: string;
  judgeModel: string;
  repoMode: RepoMode;
  maxCost?: string;
  concurrency: string;
  judgeConcurrency: string;
  force?: boolean;
  trace?: boolean;
}>();

const safeName = (s: string) => s.replace(/[^\w.@-]/g, "_");
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf-8")) as T;
const writeJson = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf-8");
};

/** The agent configuration every instance is reviewed with (schema defaults + CLI overrides). */
function createAgent(): PRAgent {
  return new PRAgent({
    model: opts.reviewModel,
    telemetry: { enabled: Boolean(opts.trace) },
    ...(opts.maxCost !== undefined ? { budget: { maxCostUsd: Number(opts.maxCost) } } : {}),
  });
}

/** Commit of the agent code under test, so a score can be traced back to the code that produced it. */
function gitRevision(): { commit: string | null; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--", "src", "bench"], {
      encoding: "utf-8",
    });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: true };
  }
}

function toGenerated(c: EmittedComment): GeneratedComment {
  return {
    path: c.path,
    startLine: c.start_line,
    endLine: c.line,
    severity: c.severity,
    category: c.category,
    text: `${c.title}\n\n${c.body}`.trim(),
  };
}

async function reviewInstance(instance: BenchInstance, outFile: string): Promise<ReviewRecord> {
  const started = Date.now();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const ws = await prepareWorkspace(instance, opts.repoMode);
    cleanup = ws.cleanup;

    const agent = createAgent();
    const [owner, repo] = instance.repo.split("/");
    const result = await agent.runReview({
      owner,
      repo,
      pull_number: instance.prNumber,
      commit_id: ws.headCommit,
      rawDiff: ws.rawDiff,
      repoDir: ws.repoDir,
      background: `PR title: ${ws.prTitle}\n\n${ws.prBody.slice(0, 4000)}`.trim(),
    });

    // Score exactly what would be posted: the same per-review cap the assembler applies.
    const posted = result.findings.slice(0, agent.config.review.maxCommentsPerReview);
    const record: ReviewRecord = {
      instanceId: instance.id,
      status: "ok",
      baseCommit: ws.baseCommit,
      headCommit: ws.headCommit,
      diffFiles: (ws.rawDiff.match(/^diff --git /gm) ?? []).length,
      diffBytes: ws.rawDiff.length,
      model: opts.reviewModel,
      durationMs: Date.now() - started,
      usage: result.usage,
      agentRunId: result.runId,
      skippedFiles: result.skippedFiles,
      groups: result.groups.map((g) => ({
        group: g.group,
        files: g.files,
        stopReason: g.stopReason,
        costUsd: g.costUsd,
        ...(g.error ? { error: g.error } : {}),
      })),
      comments: posted.map(toGenerated),
    };
    writeJson(outFile, record);
    return record;
  } catch (err) {
    const record: ReviewRecord = {
      instanceId: instance.id,
      status: "error",
      error: (err as Error).stack || String(err),
      model: opts.reviewModel,
      durationMs: Date.now() - started,
      comments: [],
    };
    writeJson(outFile, record);
    return record;
  } finally {
    await cleanup?.().catch(() => undefined);
  }
}

async function main() {
  let instances = await loadDataset(opts.dataset);
  const totalInDataset = instances.length;
  if (opts.ids) {
    const wanted = new Set(opts.ids.split(",").map((s) => s.trim()));
    instances = instances.filter((i) => wanted.has(i.id));
  } else if (opts.limit) {
    instances = seededShuffle(instances, Number(opts.seed)).slice(0, Number(opts.limit));
  }

  const runId =
    opts.runId ||
    (opts.stage === "eval"
      ? undefined
      : `${new Date().toISOString().replace(/[:.]/g, "-")}_${safeName(opts.reviewModel)}`);
  if (!runId) throw new Error("--run-id is required for --stage eval");
  const runDir = path.resolve("bench/results", opts.dataset, runId);
  const reviewsDir = path.join(runDir, "reviews");
  const evalDir = path.join(runDir, `eval_${safeName(opts.judgeModel)}`);

  console.log(
    pc.bold(
      pc.cyan(
        `\n=== PR-Agent bench: ${opts.dataset} (${instances.length}/${totalInDataset} instances) ===`,
      ),
    ),
  );
  console.log(`run dir      ${runDir}`);
  console.log(
    `review model ${opts.reviewModel}   judge model ${opts.judgeModel}   repo mode ${opts.repoMode}`,
  );

  // ---- Review stage ----------------------------------------------------------------------
  if (opts.stage !== "eval") {
    const { apiKey: _apiKey, ...agentConfig } = createAgent().config;
    const revision = gitRevision();
    if (revision.dirty) {
      console.log(
        pc.yellow("warning: src/ or bench/ has uncommitted changes; scores are not reproducible"),
      );
    }
    writeJson(path.join(runDir, "run.json"), {
      dataset: opts.dataset,
      reviewModel: opts.reviewModel,
      git: revision,
      agentConfig,
      repoMode: opts.repoMode,
      limit: opts.limit ?? null,
      seed: opts.limit ? Number(opts.seed) : null,
      instanceIds: instances.map((i) => i.id),
      startedAt: new Date().toISOString(),
    });

    const limit = createLimiter(Number(opts.concurrency));
    let done = 0;
    await Promise.all(
      instances.map((inst) =>
        limit(async () => {
          const file = path.join(reviewsDir, `${safeName(inst.id)}.json`);
          if (!opts.force && fs.existsSync(file) && readJson<ReviewRecord>(file).status === "ok") {
            done++;
            return;
          }
          const rec = await reviewInstance(inst, file);
          done++;
          const tag = rec.status === "ok" ? pc.green("ok   ") : pc.red("error");
          const cut = rec.groups?.filter((g) => g.stopReason !== "none").length ?? 0;
          console.log(
            `[${done}/${instances.length}] ${tag} ${inst.id}  comments=${rec.comments.length}  ` +
              `cost=$${(rec.usage?.costUsd ?? 0).toFixed(3)}  groups=${rec.groups?.length ?? 0}` +
              (cut ? pc.yellow(` (${cut} cut short)`) : "") +
              `  ${(rec.durationMs / 1000).toFixed(0)}s` +
              (rec.error ? `  ${pc.red(rec.error.split("\n")[0].slice(0, 160))}` : ""),
          );
        }),
      ),
    );
    if (opts.trace) await flushTelemetry();
  }

  if (opts.stage === "review") return;

  // ---- Eval stage ------------------------------------------------------------------------
  const missing = instances
    .filter((inst) => !fs.existsSync(path.join(reviewsDir, `${safeName(inst.id)}.json`)))
    .map((inst) => inst.id);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} selected instance(s) have no review yet (${missing.slice(0, 5).join(", ")}); ` +
        "finish the review stage first",
    );
  }
  // Failed reviews stay in the denominators: they are scored as reviews with no comments, so every
  // reference they should have found counts as missed instead of silently dropping hard instances.
  const records = instances.map((inst) =>
    readJson<ReviewRecord>(path.join(reviewsDir, `${safeName(inst.id)}.json`)),
  );
  const reviews = records.filter((r) => r.status === "ok");
  const failed = records.filter((r) => r.status !== "ok").map((r) => r.instanceId);
  const byId = new Map(instances.map((i) => [i.id, i]));

  const reviewModel = reviews[0]?.model ?? opts.reviewModel;
  if (reviewModel === opts.judgeModel) {
    console.log(
      pc.yellow(`warning: judge model equals review model (${reviewModel}); scores may be biased`),
    );
  }
  const judge = new BenchJudge(opts.judgeModel, Number(opts.judgeConcurrency));

  const evals = await Promise.all(
    records.map(async (rec) => {
      const file = path.join(evalDir, `${safeName(rec.instanceId)}.json`);
      if (!opts.force && fs.existsSync(file))
        return readJson<AacrInstanceEval | MartianInstanceEval>(file);
      const inst = byId.get(rec.instanceId)!;
      if (rec.status !== "ok") rec.comments = [];
      const ev =
        opts.dataset === "aacr"
          ? await evaluateAacr(inst, rec, judge)
          : await evaluateMartian(inst, rec, judge);
      writeJson(file, ev);
      return ev;
    }),
  );

  const scores =
    opts.dataset === "aacr"
      ? aggregateAacr(evals as AacrInstanceEval[])
      : aggregateMartian(evals as MartianInstanceEval[]);

  const usage = reviews.reduce(
    (s, r) => ({
      promptTokens: s.promptTokens + (r.usage?.promptTokens ?? 0),
      completionTokens: s.completionTokens + (r.usage?.completionTokens ?? 0),
      costUsd: s.costUsd + (r.usage?.costUsd ?? 0),
      durationMs: s.durationMs + r.durationMs,
    }),
    { promptTokens: 0, completionTokens: 0, costUsd: 0, durationMs: 0 },
  );
  // How file groups ended: anything but "none" means the agent was cut short (budget, rounds, errors).
  const groupStopReasons: Record<string, number> = {};
  for (const r of reviews) {
    for (const g of r.groups ?? []) {
      groupStopReasons[g.stopReason] = (groupStopReasons[g.stopReason] ?? 0) + 1;
    }
  }

  const metrics = {
    dataset: opts.dataset,
    runId,
    reviewModel,
    judgeModel: opts.judgeModel,
    evaluatedAt: new Date().toISOString(),
    selectedInstances: instances.length,
    // Failed reviews are scored as empty reviews (all their references count as missed).
    failedReviewIds: failed,
    judgeCalls: judge.calls,
    judgeCallFailures: judge.failures,
    review: {
      avgDurationSec: reviews.length
        ? Number((usage.durationMs / reviews.length / 1000).toFixed(1))
        : 0,
      totalPromptTokens: usage.promptTokens,
      totalCompletionTokens: usage.completionTokens,
      avgTotalTokens: reviews.length
        ? Math.round((usage.promptTokens + usage.completionTokens) / reviews.length)
        : 0,
      totalCostUsd: Number(usage.costUsd.toFixed(4)),
      avgCostUsd: reviews.length ? Number((usage.costUsd / reviews.length).toFixed(4)) : 0,
      groupStopReasons,
    },
    scores,
  };
  writeJson(path.join(evalDir, "metrics.json"), metrics);

  console.log(pc.bold(pc.green("\n=== Metrics ===")));
  console.log(JSON.stringify(metrics.scores, null, 2));
  console.log(
    `reviews ok=${reviews.length} failed=${failed.length}  cost=$${usage.costUsd.toFixed(3)}  ` +
      `judge calls=${judge.calls} failures=${judge.failures}`,
  );
  console.log(`written to ${path.join(evalDir, "metrics.json")}`);
}

main().catch((err) => {
  console.error(pc.red((err as Error).stack || String(err)));
  process.exit(1);
});
