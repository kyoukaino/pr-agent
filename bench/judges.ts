import { DeepSeekLLMClient } from "../src/llm/client.js";
import type { GeneratedComment, ReferenceComment } from "./types.js";

/** Minimal promise pool so judge calls run concurrently without flooding the API. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export class BenchJudge {
  private client: DeepSeekLLMClient;
  private limit: ReturnType<typeof createLimiter>;
  public calls = 0;
  public failures = 0;

  constructor(
    public readonly model: string,
    concurrency: number,
  ) {
    this.client = new DeepSeekLLMClient({ model, temperature: 0 });
    this.limit = createLimiter(concurrency);
  }

  /**
   * Calls the judge and parses its answer; retries on unparseable output.
   * Never invents a verdict: after the last attempt the error is returned to the caller.
   */
  private async ask<T>(
    prompt: string,
    parse: (text: string) => T | null,
    system?: string,
  ): Promise<{ value?: T; raw: string; error?: string }> {
    return this.limit(async () => {
      let lastRaw = "";
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        this.calls++;
        try {
          const resp = await this.client.chatCompletion([
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user", content: prompt },
          ]);
          lastRaw = resp.content;
          const value = parse(resp.content);
          if (value !== null) return { value, raw: resp.content };
          lastError = "unparseable judge output";
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      this.failures++;
      return { raw: lastRaw, error: lastError };
    });
  }

  /**
   * AACR-Bench file-level semantic coverage: one call per generated comment against all references
   * in the same file; returns the 0-based indices (into `refs`) it covers.
   * Prompt ported from alibaba/aacr-bench evaluation/judge.py (match_llm_file_level), Apache-2.0.
   */
  async aacrFileLevel(
    gen: GeneratedComment,
    refs: ReferenceComment[],
    filePath: string,
  ): Promise<{ matched: number[]; reason: string; error?: string }> {
    const lineStr = (s?: number, e?: number) => (s && e ? `${s}-${e}` : "?");
    const numbered = refs
      .map((r, i) => `${i + 1}. [L${lineStr(r.startLine, r.endLine)}] ${r.text}`)
      .join("\n");

    const prompt = `
-Role-

You are an expert code reviewer comparing review comments for semantic equivalence.

-Task-

Given a Generated Comment and a numbered list of Reference Comments (all from the same file: ${filePath}), determine which Reference Comments express the same concern or suggestion as the Generated Comment.

Focus solely on semantic equivalence of the underlying issue — ignore differences in wording, tone, formatting, or exact line numbers. If the Generated Comment addresses the same core problem as a Reference Comment, include that Reference Comment's number.

-Generated Comment-
[L${lineStr(gen.startLine ?? gen.endLine, gen.endLine)}] ${gen.text}

-Reference Comments-
${numbered}

-Output-

For each Reference Comment, briefly state whether it matches and why (one line each).
Then return a JSON array of matched numbers on the LAST line. If none match, return [].

Example:
1. Match — both flag the uninitialized variable risk
2. No match — ref discusses naming, generated discusses null check
3. Match — same concern about missing error handling

[1, 3]

Your answer:
`;
    const res = await this.ask(prompt, (text) => {
      const arrays = text.match(/\[[\d,\s]*\]/g);
      if (!arrays) return null;
      const nums = JSON.parse(arrays[arrays.length - 1]) as unknown[];
      return [
        ...new Set(
          nums.filter(
            (n): n is number =>
              Number.isInteger(n) && (n as number) >= 1 && (n as number) <= refs.length,
          ),
        ),
      ].map((n) => n - 1);
    });
    return { matched: res.value ?? [], reason: res.raw.slice(-600), error: res.error };
  }

  /**
   * Martian pairwise judge: does the candidate describe the same underlying issue as the golden comment?
   * Prompt ported from withmartian/code-review-benchmark offline/code_review_benchmark/step3_judge_comments.py, MIT.
   */
  async martianMatch(
    golden: string,
    candidate: string,
  ): Promise<{ match: boolean; confidence: number; reasoning: string; error?: string }> {
    const prompt = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
${golden}

Candidate Issue (from the tool's review):
${candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

    const res = await this.ask(
      prompt,
      (text) => {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
          const obj = JSON.parse(m[0]) as {
            match?: unknown;
            confidence?: unknown;
            reasoning?: unknown;
          };
          if (typeof obj.match !== "boolean") return null;
          return {
            match: obj.match,
            confidence: Number(obj.confidence) || 0,
            reasoning: String(obj.reasoning ?? ""),
          };
        } catch {
          return null;
        }
      },
      "You are a precise code review evaluator. Always respond with valid JSON.",
    );
    if (!res.value) return { match: false, confidence: 0, reasoning: "", error: res.error };
    return res.value;
  }
}
