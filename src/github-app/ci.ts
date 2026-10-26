import * as fs from "node:fs";
import * as path from "node:path";
import type { Octokit } from "@octokit/rest";
import { CI_LOGS_MOUNT } from "../domain/workspace.js";

/**
 * CI context for a PR head commit, read from the GitHub Checks API (check runs and their
 * annotations) and the commit status API (external CI such as Jenkins).
 *
 * CI output is produced by the code under review, so everything here is untrusted data: the summary
 * is rendered for a tagged prompt section, and full logs are only exposed as read-only files.
 */

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const MAX_ANNOTATIONS_PER_RUN = 20;
const MAX_ANNOTATIONS_TOTAL = 50;
const MAX_MESSAGE_CHARS = 300;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface CiCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  title?: string | null;
  /** App that produced the run; job logs are downloadable only for GitHub Actions. */
  appSlug?: string;
}

export interface CiAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: string;
  title?: string | null;
  message: string;
}

export interface CiStatus {
  context: string;
  state: string;
  description?: string | null;
}

export interface CiSnapshot {
  runs: CiCheckRun[];
  statuses: CiStatus[];
}

/** Whether any check run or commit status of the commit is still running. */
export function isCiPending(snapshot: CiSnapshot): boolean {
  return (
    snapshot.runs.some((r) => r.status !== "completed") ||
    snapshot.statuses.some((s) => s.state === "pending")
  );
}

export function isFailedRun(run: CiCheckRun): boolean {
  return run.status === "completed" && FAILED_CONCLUSIONS.has(run.conclusion ?? "");
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Stable, path-safe file name for a check run's log. */
export function logFileName(run: CiCheckRun): string {
  return `${run.name.replace(/[^\w.-]+/g, "_").slice(0, 80)}-${run.id}.log`;
}

/**
 * Renders the structured summary injected into the review task: one line per check, the failure
 * annotations (file, lines, message) of failed checks, and where the full logs can be read.
 */
export function renderCiSummary(
  snapshot: CiSnapshot,
  annotations: Map<number, CiAnnotation[]>,
  logFiles: Map<number, string>,
): string {
  const lines: string[] = [];
  let budget = MAX_ANNOTATIONS_TOTAL;
  const runs = [...snapshot.runs].sort(
    (a, b) => Number(isFailedRun(b)) - Number(isFailedRun(a)) || a.name.localeCompare(b.name),
  );
  for (const run of runs) {
    const result = run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
    const title = run.title ? `: ${clip(run.title, 120)}` : "";
    lines.push(`- ${run.name} (${result})${title}`);
    if (!isFailedRun(run)) continue;
    const anns = (annotations.get(run.id) ?? [])
      .filter((a) => a.level !== "notice")
      .sort((a, b) => Number(b.level === "failure") - Number(a.level === "failure"))
      .slice(0, Math.min(MAX_ANNOTATIONS_PER_RUN, budget));
    budget -= anns.length;
    for (const a of anns) {
      const range = a.endLine > a.startLine ? `${a.startLine}-${a.endLine}` : `${a.startLine}`;
      const head = a.title ? `${clip(a.title, 80)}: ` : "";
      lines.push(
        `  - ${a.path}:${range} [${a.level}] ${head}${clip(a.message, MAX_MESSAGE_CHARS)}`,
      );
    }
    const log = logFiles.get(run.id);
    if (log) lines.push(`  - full log: ${CI_LOGS_MOUNT}/${log}`);
  }
  for (const s of snapshot.statuses) {
    const desc = s.description ? `: ${clip(s.description, 120)}` : "";
    lines.push(`- ${s.context} (${s.state})${desc}`);
  }
  return lines.join("\n");
}

/** Strips ANSI colors and the GitHub Actions timestamp prefix so logs read and grep cleanly. */
export function cleanLog(raw: string): string {
  // ANSI escape sequences start with the ESC control character; matching it is the point.
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
  return raw.replace(ansi, "").replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /gm, "");
}

export async function fetchCiSnapshot(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<CiSnapshot> {
  const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
    owner,
    repo,
    ref: sha,
    filter: "latest",
    per_page: 100,
  });
  const combined = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha });
  return {
    runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      title: r.output?.title,
      appSlug: r.app?.slug,
    })),
    statuses: combined.data.statuses.map((s) => ({
      context: s.context,
      state: s.state,
      description: s.description,
    })),
  };
}

export interface CiContext {
  /** Rendered summary for the `<ci_results>` prompt section; empty when the commit has no CI. */
  summary: string;
  /** Directory holding the failed jobs' logs, mounted at CI_LOGS_MOUNT; undefined if none. */
  logsDir?: string;
  cleanup: () => void;
}

/**
 * Collects annotations and (for GitHub Actions) cleaned logs of failed checks. Missing annotations
 * or logs only shrink the context; they never fail the review.
 */
export async function collectCiContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  snapshot: CiSnapshot,
  workDir: string,
): Promise<CiContext> {
  if (snapshot.runs.length === 0 && snapshot.statuses.length === 0) {
    return { summary: "", cleanup: () => {} };
  }

  const annotations = new Map<number, CiAnnotation[]>();
  const logFiles = new Map<number, string>();
  const logsDir = fs.mkdtempSync(path.join(workDir, "pr-agent-ci-"));
  const cleanup = () => fs.rmSync(logsDir, { recursive: true, force: true });

  for (const run of snapshot.runs.filter(isFailedRun)) {
    try {
      const res = await octokit.rest.checks.listAnnotations({
        owner,
        repo,
        check_run_id: run.id,
        per_page: 100,
      });
      annotations.set(
        run.id,
        res.data.map((a) => ({
          path: a.path,
          startLine: a.start_line,
          endLine: a.end_line,
          level: a.annotation_level ?? "failure",
          title: a.title,
          message: a.message ?? "",
        })),
      );
    } catch {
      // annotations are optional context
    }

    // For GitHub Actions the check run id is the job id.
    if (run.appSlug !== "github-actions") continue;
    try {
      const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: run.id,
      });
      const raw = typeof res.data === "string" ? res.data : await (await fetch(res.url)).text();
      const text = cleanLog(raw);
      // Failures are usually at the end of a log; keep the tail when it is huge.
      const kept = text.length > MAX_LOG_BYTES ? text.slice(-MAX_LOG_BYTES) : text;
      const name = logFileName(run);
      fs.writeFileSync(path.join(logsDir, name), kept, "utf-8");
      logFiles.set(run.id, name);
    } catch {
      // logs expired or not accessible: the summary still carries the conclusion
    }
  }

  return {
    summary: renderCiSummary(snapshot, annotations, logFiles),
    logsDir: logFiles.size > 0 ? logsDir : undefined,
    cleanup,
  };
}

/**
 * Wait for CI before reviewing, up to a deadline: review once nothing is running any more, or when
 * the deadline passes (the summary then shows the checks that are still running).
 */
export function shouldWaitForCi(snapshot: CiSnapshot, now: number, deadline: number): boolean {
  return isCiPending(snapshot) && now < deadline;
}
