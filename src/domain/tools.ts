import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import type { OpenAI } from "openai";
import type { EmittedComment } from "./github-types.js";
import { AgentTelemetry } from "../telemetry/otel.js";

export const MAIN_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "code_comment",
      description:
        "Submits an identified defect, bug, security vulnerability, or actionable improvement on the reviewed code.",
      parameters: {
        type: "object",
        required: ["path", "line", "severity", "category", "title", "body"],
        properties: {
          path: {
            type: "string",
            description: "The relative path to the file being reviewed.",
          },
          line: {
            type: "integer",
            description:
              "The line of the blob in the pull request diff that the comment applies to (for multi-line, the ending line).",
          },
          start_line: {
            type: "integer",
            description: "Optional start line for multi-line comments.",
          },
          side: {
            type: "string",
            enum: ["LEFT", "RIGHT"],
            description: "RIGHT for additions/modifications (default), LEFT for deletions.",
          },
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3", "P4"],
            description:
              "P0=Blocker/Security, P1=Critical Bug, P2=Major Logic/Performance, P3=Minor Defect, P4=Nitpick/Style.",
          },
          category: {
            type: "string",
            enum: ["security", "bug", "performance", "maintainability", "logic"],
            description: "Category of the finding.",
          },
          title: {
            type: "string",
            description: "Concise summary of the finding.",
          },
          body: {
            type: "string",
            description:
              "Detailed markdown description explaining: 1. Cause, 2. Impact/Harm, 3. Explanation.",
          },
          suggested_code: {
            type: "string",
            description: "Optional exact code replacement for GitHub suggestion block.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Reads lines of a file in the repository (head revision) to inspect definitions, callers, or context. Returns at most 400 lines per call; pass start_line/end_line for large files.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Relative file path to read.",
          },
          start_line: {
            type: "integer",
            description: "Optional starting line number (1-based).",
          },
          end_line: {
            type: "integer",
            description: "Optional ending line number (1-based).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_code",
      description:
        "Searches the repository with ripgrep (Rust regex syntax, smart-case). Skips .gitignore-d, binary, minified and lock files. Returns at most 50 matching lines as path:line: text.",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: {
            type: "string",
            description: "Text or regex pattern to search for.",
          },
          file_extension: {
            type: "string",
            description: "Optional file extension filter, e.g. '.ts', '.go', '.py'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_done",
      description: "Signals that all analysis and reviews for the current file group are finished.",
      parameters: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["DONE", "FAILED"],
            description: "Final outcome state.",
          },
        },
      },
    },
  },
];

/** Output limits that keep a single tool result from flooding the context window. */
export const TOOL_OUTPUT_LIMITS = {
  readFileMaxLines: 400,
  maxLineChars: 400,
  maxOutputChars: 40_000,
  grepMaxMatches: 50,
  grepMaxMatchesPerFile: 8,
  grepTimeoutMs: 20_000,
};

// Generated artifacts whose matches are noise for review (minified bundles, source maps, lockfiles).
const GREP_EXCLUDE_GLOBS = [
  "!*.min.js",
  "!*.min.css",
  "!*.map",
  "!**/package-lock.json",
  "!**/pnpm-lock.yaml",
  "!**/yarn.lock",
  "!**/composer.lock",
  "!**/Cargo.lock",
  "!**/go.sum",
  "!*.generated.*",
];

const SEVERITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);
const CATEGORIES = new Set(["security", "bug", "performance", "maintainability", "logic"]);

export interface ToolExecutionContext {
  repoDir: string;
  /** Paths changed by the PR. When set, code_comment may only target these files. */
  changedPaths?: string[];
  onCommentEmitted: (comment: EmittedComment) => void;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  result: string;
  /** The call itself failed (bad arguments, missing file, search error); counts toward the failure streak. */
  failed?: boolean;
  /** task_done was called; `completed` tells whether the model reported success. */
  done?: boolean;
  completed?: boolean;
}

class ToolInputError extends Error {}

function clipLine(line: string): string {
  const max = TOOL_OUTPUT_LIMITS.maxLineChars;
  return line.length > max ? `${line.slice(0, max)} …[${line.length - max} more chars]` : line;
}

function clipOutput(text: string): string {
  const max = TOOL_OUTPUT_LIMITS.maxOutputChars;
  return text.length > max
    ? `${text.slice(0, max)}\n…[output truncated, ${text.length - max} more chars; narrow the query]`
    : text;
}

export class ToolDispatcher {
  private ctx: ToolExecutionContext;
  private repoRoot: string;
  private changedPaths?: Set<string>;

  constructor(ctx: ToolExecutionContext) {
    this.ctx = ctx;
    this.repoRoot = fs.realpathSync(path.resolve(ctx.repoDir));
    this.changedPaths = ctx.changedPaths ? new Set(ctx.changedPaths) : undefined;
  }

  public async execute(name: string, argsJson: string): Promise<ToolExecutionResult> {
    const span = AgentTelemetry.startToolSpan(name, argsJson);
    let res: ToolExecutionResult;
    try {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsJson || "{}");
      } catch {
        throw new ToolInputError(`arguments are not valid JSON: ${argsJson.slice(0, 200)}`);
      }

      switch (name) {
        case "code_comment":
          res = { result: this.codeComment(args) };
          break;
        case "task_done": {
          const completed = args.state !== "FAILED";
          res = {
            result: completed ? "Task completed successfully." : "Task ended with failure.",
            done: true,
            completed,
          };
          break;
        }
        case "read_file":
          res = { result: this.readFile(args) };
          break;
        case "grep_code":
          res = { result: await this.grep(args) };
          break;
        default:
          throw new ToolInputError(`unknown tool '${name}'`);
      }
      AgentTelemetry.recordToolResult(span, res.result);
    } catch (err) {
      const message = `Error executing tool '${name}': ${(err as Error).message}`;
      AgentTelemetry.recordToolResult(span, "", err as Error);
      res = { result: message, failed: true };
    }
    span.end();
    return res;
  }

  /** Resolves a model-supplied path inside the repository, rejecting traversal and symlink escapes. */
  private resolveInRepo(p: unknown): { abs: string; rel: string } {
    if (typeof p !== "string" || !p.trim()) throw new ToolInputError("'path' is required");
    const abs = path.resolve(this.repoRoot, p);
    const escapes = (target: string) => {
      const rel = path.relative(this.repoRoot, target);
      return rel.startsWith("..") || path.isAbsolute(rel);
    };
    if (escapes(abs)) throw new ToolInputError(`path '${p}' is outside the repository`);
    if (!fs.existsSync(abs)) throw new ToolInputError(`file '${p}' does not exist`);
    if (escapes(fs.realpathSync(abs))) {
      throw new ToolInputError(`path '${p}' is outside the repository`);
    }
    return { abs, rel: path.relative(this.repoRoot, abs).replace(/\\/g, "/") };
  }

  private codeComment(args: Record<string, unknown>): string {
    const filePath =
      typeof args.path === "string" ? args.path.replace(/\\/g, "/").replace(/^\.?\//, "") : "";
    const line = Number(args.line);
    if (!filePath) throw new ToolInputError("'path' is required");
    if (!Number.isInteger(line) || line < 1) {
      throw new ToolInputError("'line' must be a positive integer");
    }
    if (this.changedPaths && !this.changedPaths.has(filePath)) {
      throw new ToolInputError(
        `'${filePath}' is not changed in this PR; comments must target a changed file (describe cross-file impact on the changed line instead)`,
      );
    }
    const startLine = args.start_line === undefined ? undefined : Number(args.start_line);
    const comment: EmittedComment = {
      id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      path: filePath,
      line,
      start_line:
        startLine !== undefined && Number.isInteger(startLine) && startLine >= 1 && startLine < line
          ? startLine
          : undefined,
      side: args.side === "LEFT" ? "LEFT" : "RIGHT",
      severity: SEVERITIES.has(String(args.severity))
        ? (args.severity as EmittedComment["severity"])
        : "P2",
      category: CATEGORIES.has(String(args.category))
        ? (args.category as EmittedComment["category"])
        : "bug",
      title: typeof args.title === "string" && args.title ? args.title : "Review Comment",
      body: typeof args.body === "string" ? args.body : "",
      suggested_code: typeof args.suggested_code === "string" ? args.suggested_code : undefined,
    };
    this.ctx.onCommentEmitted(comment);
    return `Comment recorded successfully on ${comment.path}:${comment.line}.`;
  }

  private readFile(args: Record<string, unknown>): string {
    const { abs, rel } = this.resolveInRepo(args.path);
    if (!fs.statSync(abs).isFile()) throw new ToolInputError(`'${rel}' is not a file`);
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new ToolInputError(`'${rel}' is a binary file`);

    const lines = buf.toString("utf-8").split("\n");
    const start = Math.max(1, Number(args.start_line) || 1);
    if (start > lines.length) throw new ToolInputError(`'${rel}' has only ${lines.length} lines`);
    const requestedEnd = Math.min(lines.length, Number(args.end_line) || lines.length);
    const end = Math.min(requestedEnd, start + TOOL_OUTPUT_LIMITS.readFileMaxLines - 1);

    const body = lines
      .slice(start - 1, end)
      .map((line, idx) => `${start + idx} | ${clipLine(line.replace(/\r$/, ""))}`)
      .join("\n");
    const more =
      end < requestedEnd
        ? `\n…[showing L${start}-L${end} of ${lines.length}; request a narrower range]`
        : "";
    return clipOutput(`--- ${rel} (L${start}-L${end} of ${lines.length}) ---\n${body}${more}`);
  }

  /** Repository search via ripgrep: linear-time regex, honors .gitignore, skips binaries and generated files. */
  private async grep(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern;
    if (typeof pattern !== "string" || !pattern) throw new ToolInputError("'pattern' is required");
    const L = TOOL_OUTPUT_LIMITS;

    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "--smart-case",
      "--path-separator=/",
      `--max-columns=${L.maxLineChars}`,
      "--max-columns-preview",
      `--max-count=${L.grepMaxMatchesPerFile}`,
      "--max-filesize=2M",
      ...GREP_EXCLUDE_GLOBS.flatMap((g) => ["--glob", g]),
    ];
    if (typeof args.file_extension === "string" && args.file_extension) {
      const ext = args.file_extension.startsWith(".")
        ? args.file_extension
        : `.${args.file_extension}`;
      rgArgs.push("--glob", `*${ext}`);
    }
    // An explicit path is required: with no path and a piped stdin, rg searches stdin instead.
    rgArgs.push("--regexp", pattern, "--", ".");

    const { lines, truncated } = await new Promise<{ lines: string[]; truncated: boolean }>(
      (resolve, reject) => {
        const child = spawn(rgPath, rgArgs, {
          cwd: this.repoRoot,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const clean = (line: string) => line.replace(/\r$/, "").replace(/^\.\//, "");
        const out: string[] = [];
        let pending = "";
        let stderr = "";
        let truncated = false;
        const timer = setTimeout(() => {
          truncated = true;
          child.kill();
        }, L.grepTimeoutMs);
        const onAbort = () => child.kill();
        this.ctx.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          pending += chunk;
          const parts = pending.split("\n");
          pending = parts.pop() ?? "";
          for (const part of parts) {
            if (out.length >= L.grepMaxMatches) {
              truncated = true;
              child.kill();
              return;
            }
            if (part) out.push(clean(part));
          }
        });
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (d: string) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          this.ctx.signal?.removeEventListener("abort", onAbort);
          if (pending && out.length < L.grepMaxMatches) out.push(clean(pending));
          // rg exit codes: 0 = matches, 1 = no matches, 2 = error (invalid regex, etc.).
          if (code === 2 && !truncated) {
            reject(new ToolInputError(stderr.trim().split("\n").slice(-3).join(" ")));
          } else {
            resolve({ lines: out, truncated });
          }
        });
      },
    );

    if (lines.length === 0) return `No matches found for pattern '${pattern}'.`;
    const note = truncated
      ? `\n…[results truncated at ${lines.length} matches; refine the pattern or add file_extension]`
      : "";
    return clipOutput(lines.join("\n") + note);
  }
}
