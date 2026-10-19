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
              "P0=Blocker/Security, P1=Critical Bug, P2=Major Logic/Performance, P3=Minor Defect, P4=Objective but low-impact issue (typo, grammar error, inaccurate comment or doc). Never use it for subjective style.",
          },
          category: {
            type: "string",
            enum: ["security", "bug", "performance", "maintainability", "logic", "documentation"],
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
        "Reads lines of a file in the repository (head revision) to inspect definitions, callers, or context, or of a CI log listed in <ci_results>. Returns at most 400 lines per call; pass start_line/end_line for large files.",
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
          path: {
            type: "string",
            description:
              "Optional directory or file to search instead of the whole repository, e.g. 'src/auth' or a CI log listed in <ci_results>.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_finding",
      description:
        "Closes one of the findings listed under <open_findings> because the current code fixes it. Verify the fix in the code first; never use it for findings you merely disagree with now.",
      parameters: {
        type: "object",
        required: ["id", "reason"],
        properties: {
          id: {
            type: "string",
            description: "Id of the open finding, exactly as listed.",
          },
          reason: {
            type: "string",
            description: "One sentence on how the code now fixes it, shown to the author.",
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

/** Path prefix under which failed CI job logs are mounted read-only for read_file / grep_code. */
export const CI_LOGS_MOUNT = "@ci-logs";

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
const CATEGORIES = new Set([
  "security",
  "bug",
  "performance",
  "maintainability",
  "logic",
  "documentation",
]);

export interface ToolExecutionContext {
  repoDir: string;
  /** Paths changed by the PR. When set, code_comment may only target these files. */
  changedPaths?: string[];
  onCommentEmitted: (comment: EmittedComment) => void;
  /** Ids resolve_finding accepts: findings posted by earlier reviews and still open. */
  openFindingIds?: ReadonlySet<string>;
  /** Ids already resolved in this review (shared across file groups). */
  resolvedFindingIds?: Set<string>;
  onFindingResolved?: (resolved: { id: string; reason: string }) => void;
  signal?: AbortSignal;
  /**
   * Read-only directories exposed under a path prefix, e.g. { "@ci-logs": "/tmp/pr-agent-ci-x" }.
   * read_file and grep_code (with an explicit path) reach them; the default repository-wide search
   * does not, so they never add noise to code searches.
   */
  mounts?: Record<string, string>;
}

interface ResolvedPath {
  abs: string;
  /** Path as shown to the model: repository-relative, or `<mount>/<relative>`. */
  rel: string;
  /** Repository root or mount directory the path lives under. */
  root: string;
  mount?: string;
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
  private mounts: Map<string, string>;

  constructor(ctx: ToolExecutionContext) {
    this.ctx = ctx;
    this.repoRoot = fs.realpathSync(path.resolve(ctx.repoDir));
    this.changedPaths = ctx.changedPaths ? new Set(ctx.changedPaths) : undefined;
    this.mounts = new Map(
      Object.entries(ctx.mounts ?? {}).map(([name, dir]) => [name, fs.realpathSync(dir)]),
    );
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
        case "resolve_finding":
          res = { result: this.resolveFinding(args) };
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
  /**
   * Resolves a model-supplied path inside the repository or a mount, rejecting traversal and
   * symlink escapes from whichever root it belongs to.
   */
  private resolvePath(p: unknown): ResolvedPath {
    if (typeof p !== "string" || !p.trim()) throw new ToolInputError("'path' is required");
    const normalized = p.replace(/\\/g, "/");
    const mount = [...this.mounts.keys()].find(
      (m) => normalized === m || normalized.startsWith(`${m}/`),
    );
    const root = mount ? this.mounts.get(mount)! : this.repoRoot;
    const inner = mount ? normalized.slice(mount.length + 1) || "." : p;

    const abs = path.resolve(root, inner);
    const escapes = (target: string) => {
      const rel = path.relative(root, target);
      return rel.startsWith("..") || path.isAbsolute(rel);
    };
    if (escapes(abs)) throw new ToolInputError(`path '${p}' is outside the repository`);
    if (!fs.existsSync(abs)) throw new ToolInputError(`file '${p}' does not exist`);
    if (escapes(fs.realpathSync(abs))) {
      throw new ToolInputError(`path '${p}' is outside the repository`);
    }
    const relInRoot = path.relative(root, abs).replace(/\\/g, "/");
    const rel = mount ? (relInRoot ? `${mount}/${relInRoot}` : mount) : relInRoot;
    return { abs, rel, root, mount };
  }

  private resolveFinding(args: Record<string, unknown>): string {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!this.ctx.openFindingIds?.has(id)) {
      throw new ToolInputError(
        `'${id}' is not an open finding; use an id listed under <open_findings>`,
      );
    }
    if (!reason) throw new ToolInputError("'reason' is required");
    if (this.ctx.resolvedFindingIds?.has(id)) return `Finding ${id} is already resolved.`;
    this.ctx.resolvedFindingIds?.add(id);
    this.ctx.onFindingResolved?.({ id, reason });
    return `Finding ${id} marked as resolved.`;
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
      // Short enough for the model to copy back into resolve_finding in a later review
      id: `f${Math.random().toString(36).slice(2, 8)}`,
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
    const { abs, rel } = this.resolvePath(args.path);
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
    // Scope: the whole repository by default, or an explicit directory / file, possibly in a mount.
    const scope =
      typeof args.path === "string" && args.path.trim() ? this.resolvePath(args.path) : null;
    const cwd = scope?.root ?? this.repoRoot;
    const target = scope ? path.relative(scope.root, scope.abs).replace(/\\/g, "/") || "." : ".";
    const shownPrefix = scope?.mount ? `${scope.mount}/` : "";
    // An explicit target is required: with no path and a piped stdin, rg searches stdin instead.
    // --with-filename keeps the path in the output even when the target is a single file.
    rgArgs.push("--with-filename", "--regexp", pattern, "--", target);

    const { lines, truncated } = await new Promise<{ lines: string[]; truncated: boolean }>(
      (resolve, reject) => {
        const child = spawn(rgPath, rgArgs, {
          cwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const clean = (line: string) => shownPrefix + line.replace(/\r$/, "").replace(/^\.\//, "");
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
