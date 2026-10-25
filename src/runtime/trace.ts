import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage, ToolCall, ToolResult } from "./types.js";
import type { TokenUsage } from "../llm/pricing.js";

export interface TraceTurn {
  turnNumber: number;
  subtaskKey: string;
  /** Wall-clock start of the turn (ISO). */
  startedAt?: string;
  requestMessages: ChatMessage[];
  responseContent: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  usage: TokenUsage;
  /** Duration of the LLM call; tool durations are on each toolResults entry. */
  durationMs: number;
}

export interface TraceCompression {
  subtaskKey: string;
  /** Wall-clock start of the compression (ISO). */
  startedAt: string;
  /** Context size that triggered it: billed prompt of the last request plus estimated additions. */
  tokensBefore: number;
  /** "billed" when tokensBefore is anchored on an API count, "estimate" when wholly estimated. */
  measuredFrom: "billed" | "estimate";
  /** Character estimate of the context afterwards (no billed count exists yet). */
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** False when nothing was replaced (all rounds fit, the summary call failed or came back empty). */
  compressed: boolean;
  /** Usage of the summarization call; absent when no call was made. */
  usage?: TokenUsage;
  durationMs: number;
}

export interface RunTraceManifest {
  runId: string;
  repo: string;
  commitId: string;
  startTime: string;
  endTime?: string;
  model: string;
  turns: TraceTurn[];
  compressions: TraceCompression[];
  finalCommentsCount: number;
  totalTokensUsed: number;
  costUsd: number;
}

export class RunTraceRecorder {
  private manifest: RunTraceManifest;
  private traceDir: string;

  constructor(
    runId: string,
    repo: string,
    commitId: string,
    model: string,
    traceDir = ".pr-agent/traces",
  ) {
    this.traceDir = traceDir;
    if (!fs.existsSync(this.traceDir)) {
      fs.mkdirSync(this.traceDir, { recursive: true });
    }
    this.manifest = {
      runId,
      repo,
      commitId,
      startTime: new Date().toISOString(),
      model,
      turns: [],
      compressions: [],
      finalCommentsCount: 0,
      totalTokensUsed: 0,
      costUsd: 0,
    };
  }

  public get manifestSnapshot(): RunTraceManifest {
    return this.manifest;
  }

  public recordTurn(turn: TraceTurn): void {
    this.manifest.turns.push(turn);
    this.manifest.totalTokensUsed += turn.usage.totalTokens;
    this.manifest.costUsd += turn.usage.costUsd;
  }

  public recordCompression(compression: TraceCompression): void {
    this.manifest.compressions.push(compression);
    if (compression.usage) {
      this.manifest.totalTokensUsed += compression.usage.totalTokens;
      this.manifest.costUsd += compression.usage.costUsd;
    }
  }

  public finalize(commentsCount: number): string {
    this.manifest.endTime = new Date().toISOString();
    this.manifest.finalCommentsCount = commentsCount;
    const filePath = path.join(this.traceDir, `trace-${this.manifest.runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.manifest, null, 2), "utf-8");
    return filePath;
  }
}
