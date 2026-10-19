import type { ChatMessage } from "../runtime/types.js";
import type { EmittedComment } from "./github-types.js";
import type { ParsedFileDiff } from "./diff-parser.js";
import { buildConcatenatedDiffsXML } from "./diff-parser.js";

export interface PromptBuildParams {
  groupLabel: string;
  groupDiffs: ParsedFileDiff[];
  allChangedPaths: string[];
  background?: string;
  confirmedComments: EmittedComment[];
  systemRule?: string;
}

export function buildSystemPrompt(customRule?: string): string {
  return `You are an elite, production-grade Automated Code Review (ACR) Agent.
Your objective is to perform comprehensive, high-precision, actionable code reviews on Pull Requests.

Core Principles:
1. High Precision, Zero Hallucination: Report objective defects whatever their size: bugs, security flaws, performance bottlenecks, race conditions, contract violations, and also typos, grammar errors and comments or docs that are wrong or contradict the code (severity P4). Do NOT report subjective preferences: naming taste, formatting a linter would fix, or alternative designs without a concrete defect.
2. Verified Line Numbers: Every diff line is prefixed with its anchor. "R<n>" is line n of the new file (use side RIGHT, line n); "L<n>" is a deleted line n of the old file (use side LEFT, line n). Copy these numbers into code_comment instead of counting lines yourself, and anchor findings to lines shown in the diff.
3. Multi-turn Reasoning: Use 'read_file' to inspect definitions/callers, 'grep_code' to find usages across the repo, 'code_comment' to record findings, and 'task_done' when all files in the group are thoroughly reviewed.
4. Report As You Go: As soon as code evidence confirms an issue, submit it with 'code_comment' before continuing the review; do not hold findings back for the end. Keep investigating suspicions that are not yet confirmed instead of submitting them.
5. Actionable Suggestions: Provide concise, copy-pasteable GitHub suggestion blocks when recommending code changes.

${customRule ? `\nRepository Specific Rules:\n${customRule}\n` : ""}`;
}

export function buildInitialUserPrompt(params: PromptBuildParams): string {
  const { groupLabel, groupDiffs, allChangedPaths, background, confirmedComments } = params;

  const currentDiffXML = buildConcatenatedDiffsXML(groupDiffs);
  const otherFiles = allChangedPaths.filter((p) => !groupDiffs.some((gd) => gd.path === p));

  let prompt = `Please review the following file group: "${groupLabel}".\n\n`;

  if (background) {
    prompt += `<requirement_background>\n${background}\n</requirement_background>\n\n`;
  }

  if (otherFiles.length > 0) {
    prompt += `<other_changed_files_in_pr>\n${otherFiles.map((p) => `- ${p}`).join("\n")}\n</other_changed_files_in_pr>\n\n`;
  }

  if (confirmedComments.length > 0) {
    prompt += `<already_reported_findings_in_earlier_rounds>\n`;
    for (const c of confirmedComments) {
      prompt += `- [${c.severity}] ${c.path}:${c.line}: ${c.title}\n`;
    }
    prompt += `(Do NOT duplicate any of the above reported findings.)\n</already_reported_findings_in_earlier_rounds>\n\n`;
  }

  prompt += `<target_file_diffs>\n${currentDiffXML}\n</target_file_diffs>\n\n`;
  prompt += `Analyze the code carefully. Call tools as needed. Once finished, call task_done.`;

  return prompt;
}

export function buildMainTaskMessages(params: PromptBuildParams): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(params.systemRule) },
    { role: "user", content: buildInitialUserPrompt(params) },
  ];
}
