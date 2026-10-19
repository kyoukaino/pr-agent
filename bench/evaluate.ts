import type { BenchJudge } from "./judges.js";
import type { BenchInstance, ReviewRecord } from "./types.js";

const round3 = (x: number) => Number(x.toFixed(3));
const f1 = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
const normPath = (p: string) =>
  p
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();

// ---------------------------------------------------------------------------------------------
// AACR-Bench: file-level semantic coverage (the benchmark's current default metric system).
// ---------------------------------------------------------------------------------------------

export interface AacrInstanceEval {
  instanceId: string;
  expected: number;
  generated: number;
  coveredReferences: number;
  matchedGenerated: number;
  judgeErrors: number;
  comments: {
    path: string;
    line: number;
    text: string;
    matchedRefIndices: number[];
    hitNewRef: boolean;
    judgeReason?: string;
    judgeError?: string;
  }[];
  references: { path?: string; lines: string; text: string; covered: boolean }[];
}

export async function evaluateAacr(
  instance: BenchInstance,
  review: ReviewRecord,
  judge: BenchJudge,
): Promise<AacrInstanceEval> {
  const refsByPath = new Map<string, number[]>();
  instance.references.forEach((r, i) => {
    const p = normPath(r.path ?? "");
    if (!refsByPath.has(p)) refsByPath.set(p, []);
    refsByPath.get(p)!.push(i);
  });

  const records = await Promise.all(
    review.comments.map(async (c) => {
      const path = normPath(c.path);
      const refIdx = refsByPath.get(path) ?? [];
      const base = {
        path,
        line: c.endLine,
        text: c.text,
        matchedRefIndices: [] as number[],
        hitNewRef: false,
      };
      if (refIdx.length === 0) return base; // No reference in this file: cannot cover anything, no judge call.
      const res = await judge.aacrFileLevel(
        c,
        refIdx.map((i) => instance.references[i]),
        path,
      );
      return {
        ...base,
        matchedRefIndices: res.matched.map((k) => refIdx[k]),
        judgeReason: res.reason,
        judgeError: res.error,
      };
    }),
  );

  // Greedy dedup in generation order: a comment counts toward precision only if it covers a new reference.
  const covered = new Set<number>();
  let matchedGenerated = 0;
  for (const r of records) {
    const fresh = r.matchedRefIndices.filter((i) => !covered.has(i));
    r.hitNewRef = fresh.length > 0;
    if (r.hitNewRef) matchedGenerated++;
    r.matchedRefIndices.forEach((i) => covered.add(i));
  }

  return {
    instanceId: instance.id,
    expected: instance.references.length,
    generated: records.length,
    coveredReferences: covered.size,
    matchedGenerated,
    judgeErrors: records.filter((r) => "judgeError" in r && r.judgeError).length,
    comments: records,
    references: instance.references.map((r, i) => ({
      path: r.path,
      lines: `${r.startLine ?? "?"}-${r.endLine ?? "?"}`,
      text: r.text,
      covered: covered.has(i),
    })),
  };
}

export function aggregateAacr(evals: AacrInstanceEval[]) {
  const sum = (
    k: "expected" | "generated" | "coveredReferences" | "matchedGenerated" | "judgeErrors",
  ) => evals.reduce((s, e) => s + e[k], 0);
  const expected = sum("expected");
  const generated = sum("generated");
  const precision = generated > 0 ? sum("matchedGenerated") / generated : 0;
  const recall = expected > 0 ? sum("coveredReferences") / expected : 0;
  return {
    metricSystem:
      "aacr file_semantic (precision = file_semantic_match_rate, recall = file_semantic_recall_rate)",
    evaluatedInstances: evals.length,
    expectedNotes: expected,
    generatedNotes: generated,
    matchedFileSemanticNotes: sum("coveredReferences"),
    matchedGeneratedNotes: sum("matchedGenerated"),
    judgeErrors: sum("judgeErrors"),
    precision: round3(precision),
    recall: round3(recall),
    balancedScore: round3(f1(precision, recall)),
  };
}

// ---------------------------------------------------------------------------------------------
// Martian offline benchmark: pairwise golden × candidate judging, scored per category profile.
// ---------------------------------------------------------------------------------------------

export const MARTIAN_PROFILES: Record<string, Set<string>> = {
  strict: new Set(["bug", "security", "concurrency", "data", "api"]),
  core: new Set([
    "bug",
    "security",
    "concurrency",
    "data",
    "api",
    "perf",
    "test_gap",
    "doc_defect",
  ]),
  all: new Set([
    "bug",
    "security",
    "concurrency",
    "data",
    "api",
    "perf",
    "test_gap",
    "doc_defect",
    "style",
    "speculative",
  ]),
};

export interface MartianInstanceEval {
  instanceId: string;
  totalCandidates: number;
  falsePositives: number;
  judgeErrors: number;
  golden: {
    text: string;
    category?: string;
    severity?: string;
    matched: boolean;
    confidence: number;
    matchedCandidate?: string;
    reasoning?: string;
  }[];
  unmatchedCandidates: string[];
}

export async function evaluateMartian(
  instance: BenchInstance,
  review: ReviewRecord,
  judge: BenchJudge,
): Promise<MartianInstanceEval> {
  const candidates = review.comments.map((c) => c.text).filter(Boolean);
  const pairs = instance.references.flatMap((g, gi) =>
    candidates.map((c, ci) => ({ gi, ci, g, c })),
  );
  const results = await Promise.all(pairs.map((p) => judge.martianMatch(p.g.text, p.c)));

  const golden = instance.references.map((g) => ({
    text: g.text,
    category: g.category,
    severity: g.severity,
    matched: false,
    confidence: 0,
    matchedCandidate: undefined as string | undefined,
    reasoning: undefined as string | undefined,
  }));
  const candidateMatched = candidates.map(() => false);
  let judgeErrors = 0;

  // Same update rule as the reference implementation: a pair only counts when it raises the
  // golden comment's best confidence, iterating golden-major / candidate-minor.
  results.forEach((res, k) => {
    const { gi, ci } = pairs[k];
    if (res.error) {
      judgeErrors++;
      return;
    }
    if (res.match && res.confidence > golden[gi].confidence) {
      golden[gi].matched = true;
      golden[gi].confidence = res.confidence;
      golden[gi].matchedCandidate = candidates[ci];
      golden[gi].reasoning = res.reasoning;
      candidateMatched[ci] = true;
    }
  });

  const unmatchedCandidates = candidates.filter((_, i) => !candidateMatched[i]);
  return {
    instanceId: instance.id,
    totalCandidates: candidates.length,
    falsePositives: unmatchedCandidates.length,
    judgeErrors,
    golden,
    unmatchedCandidates,
  };
}

export function aggregateMartian(evals: MartianInstanceEval[]) {
  const profiles: Record<string, unknown> = {};
  for (const [name, cats] of Object.entries(MARTIAN_PROFILES)) {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    for (const e of evals) {
      fp += e.falsePositives;
      for (const g of e.golden) {
        if (!cats.has(g.category ?? "")) continue; // matched-excluded / out-of-profile: neither rewarded nor penalized
        if (g.matched) tp++;
        else fn++;
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    profiles[name] = {
      tp,
      fp,
      fn,
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(f1(precision, recall)),
    };
  }
  return {
    metricSystem:
      "martian offline (precision = tp/(tp+fp), recall = tp/(tp+fn), default profile = core)",
    evaluatedInstances: evals.length,
    totalCandidates: evals.reduce((s, e) => s + e.totalCandidates, 0),
    judgeErrors: evals.reduce((s, e) => s + e.judgeErrors, 0),
    profiles,
  };
}
