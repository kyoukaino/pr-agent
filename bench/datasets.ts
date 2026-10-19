import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { downloadText, parsePrUrl } from "./github.js";
import type { BenchInstance, ReferenceComment } from "./types.js";

export const CACHE_DIR = path.resolve("bench/.cache");

/**
 * AACR-Bench (https://huggingface.co/datasets/Alibaba-Aone/aacr-bench), pinned to a dataset revision.
 * 2,145 review comments on 200 real GitHub PRs; label=1 marks the 1,505 expert-verified comments,
 * which are the reference set for review generation (same set as the repo's positive_samples.json).
 */
const AACR_REVISION = "47be1d6df1e7faf222cf531587772d92f79fe6b2";
const AACR_URL = `https://huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/${AACR_REVISION}/dataset.json`;
const AACR_SHA256 = "0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86";

/**
 * Martian Code Review Bench offline set (github.com/withmartian/code-review-benchmark), pinned to a commit.
 * 50 PRs across 5 repos with 173 human-verified golden comments (PR-level, no line anchors).
 */
const MARTIAN_COMMIT = "e616e849755441da38f18bf3adba2c9583b03803";
const MARTIAN_FILES = ["sentry", "grafana", "keycloak", "discourse", "cal_dot_com"];

interface AacrRecord {
  project_main_language: string;
  pr_url: string;
  pr_source_commit: string;
  pr_target_commit: string;
  pr_change_line_count: number;
  pr_category: string;
  note: string;
  path: string;
  side: string;
  from_line: number | null;
  to_line: number | null;
  category: string;
  context: string;
  label: number;
}

interface MartianPR {
  pr_title: string;
  url: string;
  comments: { comment: string; severity?: string; category?: string }[];
}

async function cachedDownload(url: string, file: string, sha256?: string): Promise<string> {
  const target = path.join(CACHE_DIR, file);
  let text: string;
  if (fs.existsSync(target)) {
    text = fs.readFileSync(target, "utf-8");
  } else {
    text = await downloadText(url);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf-8");
  }
  if (sha256) {
    const actual = createHash("sha256").update(text, "utf-8").digest("hex");
    if (actual !== sha256) {
      throw new Error(
        `Checksum mismatch for ${file}: expected ${sha256}, got ${actual}. Delete it and retry.`,
      );
    }
  }
  return text;
}

export async function loadAacr(): Promise<BenchInstance[]> {
  const records = JSON.parse(
    await cachedDownload(AACR_URL, "aacr/dataset.json", AACR_SHA256),
  ) as AacrRecord[];

  const byRevision = new Map<string, AacrRecord[]>();
  for (const r of records) {
    const key = `${r.pr_url}@${r.pr_target_commit}`;
    if (!byRevision.has(key)) byRevision.set(key, []);
    byRevision.get(key)!.push(r);
  }

  const instances: BenchInstance[] = [];
  for (const group of byRevision.values()) {
    const first = group[0];
    const references: ReferenceComment[] = group
      .filter((r) => r.label === 1 && r.note?.trim() && r.path)
      .map((r) => ({
        text: r.note.trim(),
        path: r.path,
        // A handful of records have from_line > to_line; keep a well-formed interval.
        startLine:
          r.from_line != null && r.to_line != null
            ? Math.min(r.from_line, r.to_line)
            : (r.from_line ?? undefined),
        endLine:
          r.from_line != null && r.to_line != null
            ? Math.max(r.from_line, r.to_line)
            : (r.to_line ?? undefined),
        side: r.side === "left" ? "left" : "right",
        category: r.category,
      }));
    // PRs whose comments were all judged incorrect carry no reference for generation.
    if (references.length === 0) continue;

    const pr = parsePrUrl(first.pr_url);
    instances.push({
      id: `${pr.owner}__${pr.name}@${first.pr_target_commit.slice(0, 7)}`,
      dataset: "aacr",
      repo: `${pr.owner}/${pr.name}`,
      prNumber: pr.number,
      prUrl: first.pr_url,
      baseCommit: first.pr_source_commit,
      headCommit: first.pr_target_commit,
      references,
      meta: {
        language: first.project_main_language,
        prCategory: first.pr_category,
        changeLines: first.pr_change_line_count,
      },
    });
  }
  return instances;
}

export async function loadMartian(): Promise<BenchInstance[]> {
  const instances: BenchInstance[] = [];
  for (const name of MARTIAN_FILES) {
    const url = `https://raw.githubusercontent.com/withmartian/code-review-benchmark/${MARTIAN_COMMIT}/offline/golden_comments/${name}.json`;
    const prs = JSON.parse(
      await cachedDownload(url, `martian/${MARTIAN_COMMIT.slice(0, 7)}/${name}.json`),
    ) as MartianPR[];
    for (const p of prs) {
      const pr = parsePrUrl(p.url);
      instances.push({
        id: `${pr.owner}__${pr.name}#${pr.number}`,
        dataset: "martian",
        repo: `${pr.owner}/${pr.name}`,
        prNumber: pr.number,
        prUrl: p.url,
        references: p.comments.map((c) => ({
          text: c.comment,
          severity: c.severity,
          category: c.category,
        })),
        meta: { sourceRepo: name, title: p.pr_title },
      });
    }
  }
  return instances;
}

export function loadDataset(name: string): Promise<BenchInstance[]> {
  if (name === "aacr") return loadAacr();
  if (name === "martian") return loadMartian();
  throw new Error(`Unknown dataset '${name}' (expected aacr | martian)`);
}

/** Deterministic Fisher–Yates shuffle (mulberry32), so `--limit N --seed S` picks a reproducible subset. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
