import type { ChatMessage, CompressedMemory } from "../runtime/types.js";
import type { DeepSeekLLMClient, LLMResponse } from "../llm/client.js";
import { countMessagesTokens } from "../runtime/budget.js";

interface Round {
  assistantIdx: number;
  toolIdxs: number[];
}

/**
 * Layout: [0] system, [1] initial task (Frozen, never modified) | [2] memory slot, present once
 * something was compressed | [historyStart..compressEnd) Compress | [compressEnd..] Active.
 *
 * The Frozen messages are never edited, only the memory slot is replaced. Provider prompt caches
 * that look up at message or block boundaries (OpenAI, Anthropic) as well as plain token-prefix
 * caches (DeepSeek) therefore keep hitting the system prompt and the diff after every compression.
 */
export interface PartitionResult {
  frozenEnd: number;
  /** First message after the Frozen zone and the memory slot. */
  historyStart: number;
  compressEnd: number;
  rounds: Round[];
  activeCount: number;
}

export function groupIntoRounds(messages: ChatMessage[], start: number): Round[] {
  const rounds: Round[] = [];
  let i = start;
  while (i < messages.length) {
    if (messages[i].role === "assistant") {
      const r: Round = { assistantIdx: i, toolIdxs: [] };
      i++;
      while (i < messages.length && messages[i].role === "tool") {
        r.toolIdxs.push(i);
        i++;
      }
      rounds.push(r);
    } else {
      i++;
    }
  }
  return rounds;
}

export function partitionMessages(
  messages: ChatMessage[],
  maxContextTokens: number,
  warningThreshold = 0.8,
): PartitionResult {
  const frozenEnd = Math.min(messages.length, 2);
  const historyStart = messages[frozenEnd]?.memory ? frozenEnd + 1 : frozenEnd;
  const result: PartitionResult = {
    frozenEnd,
    historyStart,
    compressEnd: messages.length,
    rounds: [],
    activeCount: 0,
  };

  if (messages.length <= historyStart) {
    return result;
  }

  const rounds = groupIntoRounds(messages, historyStart);
  result.rounds = rounds;
  if (rounds.length === 0) {
    return result;
  }

  // Recent rounds kept verbatim get half of the warning limit, minus the frozen prompt and the
  // current memory, so that frozen + memory + active lands well below the trigger instead of
  // re-triggering immediately.
  const frozenTokens = countMessagesTokens(messages.slice(0, historyStart));
  const budget = Math.max(0, Math.floor(maxContextTokens * warningThreshold * 0.5) - frozenTokens);

  // Compute how many trailing rounds fit in the budget from the end
  let tokensUsed = 0;
  let activeCount = 0;

  for (let i = rounds.length - 1; i >= 0; i--) {
    // Same measure as the compression trigger (countMessagesTokens), so "fits" and "over" agree.
    const roundTokens = countMessagesTokens([
      messages[rounds[i].assistantIdx],
      ...rounds[i].toolIdxs.map((ti) => messages[ti]),
    ]);
    if (tokensUsed + roundTokens > budget) {
      break;
    }
    tokensUsed += roundTokens;
    activeCount++;
  }

  result.activeCount = activeCount;

  if (activeCount >= rounds.length) {
    // Everything fits: nothing to compress. (Returning messages.length here used to make
    // compress() summarize the entire history and wipe the agent's working memory.)
    result.compressEnd = historyStart;
    result.activeCount = rounds.length;
    return result;
  }

  const activeStartIdx = rounds.length - activeCount;
  const lastCompressRound = rounds[activeStartIdx - 1];

  if (lastCompressRound.toolIdxs.length > 0) {
    result.compressEnd = lastCompressRound.toolIdxs[lastCompressRound.toolIdxs.length - 1] + 1;
  } else {
    result.compressEnd = lastCompressRound.assistantIdx + 1;
  }

  return result;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders the compressed range as a transcript that keeps the agent's trajectory: every tool call
 * with its arguments and the result it produced, not only free-text content (which is usually empty
 * on tool-calling turns).
 */
export function serializeTranscript(messages: ChatMessage[]): string {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) toolNames.set(tc.id, tc.function.name);
  }
  return messages
    .map((m) => {
      const parts: string[] = [];
      if (m.content) parts.push(escapeXml(m.content));
      for (const tc of m.tool_calls ?? []) {
        parts.push(
          `<tool_call name="${tc.function.name}">${escapeXml(tc.function.arguments)}</tool_call>`,
        );
      }
      if (m.role === "tool") {
        const name = toolNames.get(m.tool_call_id ?? "") ?? "unknown";
        return `<tool_result name="${name}">\n${parts.join("\n")}\n</tool_result>`;
      }
      return `<turn role="${m.role}">\n${parts.join("\n")}\n</turn>`;
    })
    .join("\n");
}

const MAX_ACTION_ARGS_CHARS = 300;

/**
 * Reads the trajectory straight from the tool calls of the compressed range, in call order: each
 * call's name and arguments, accepted comments marked "recorded" and failed calls annotated with
 * their error. Tool output is not kept here; what it revealed is the summary's job. Being
 * deterministic, this record survives compression regardless of summary quality.
 */
export function extractActions(messages: ChatMessage[]): string[] {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content);
  }
  const actions: string[] = [];
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      const result = results.get(tc.id) ?? "";
      let args: Record<string, unknown> | null = null;
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // kept verbatim below
      }

      const isComment = tc.function.name === "code_comment";
      // code_comment bodies are long; location, severity and title identify the finding.
      const shown =
        isComment && args
          ? JSON.stringify({
              path: args.path,
              line: args.line,
              severity: args.severity,
              title: args.title,
            })
          : args
            ? JSON.stringify(args)
            : tc.function.arguments;
      const clipped =
        shown.length > MAX_ACTION_ARGS_CHARS ? `${shown.slice(0, MAX_ACTION_ARGS_CHARS)}…` : shown;
      const outcome = result.startsWith("Error")
        ? ` → ${result.split("\n")[0]}`
        : isComment && result.startsWith("Comment recorded")
          ? " → recorded"
          : "";
      actions.push(`- ${tc.function.name} ${clipped}${outcome}`);
    }
  }
  return actions;
}

export interface CompressOptions {
  maxContextTokens: number;
  warningThreshold?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompressResult {
  messages: ChatMessage[];
  /** Usage of the summarization call; absent when no call was made. */
  usage?: LLMResponse["usage"];
}

/** Renders the memory slot's message text from its structured form. */
export function renderMemory(memory: CompressedMemory): string {
  const sections = [
    "Working memory of your earlier turns on this file group (older turns were compressed).",
  ];
  if (memory.actions.length > 0) {
    sections.push(
      `<actions_taken>\n${memory.actions.join("\n")}\n(Results are summarized below; re-run a call only if you need the exact output. Comments marked "recorded" are already submitted; do NOT submit them again.)\n</actions_taken>`,
    );
  }
  sections.push(`<previous_review_summary>\n${memory.summary}\n</previous_review_summary>`);
  return sections.join("\n\n");
}

/**
 * Three-zone Memory Compressor.
 * Never modifies the Frozen zone (system prompt + task). Older history is folded into a single
 * memory message right after it: the extracted trajectory (tool calls in order, submitted comments
 * included) plus an LLM summary of what the tool results revealed. A later compression merges the
 * previous memory into a new one, so that slot is the only message ever replaced. The Active zone
 * (most recent rounds) is kept intact.
 */
export class MemoryCompressor {
  private llmClient: DeepSeekLLMClient;

  constructor(llmClient: DeepSeekLLMClient) {
    this.llmClient = llmClient;
  }

  public async compress(
    messages: ChatMessage[],
    options: CompressOptions,
  ): Promise<CompressResult> {
    if (messages.length <= 2) return { messages };

    const partition = partitionMessages(
      messages,
      options.maxContextTokens,
      options.warningThreshold ?? 0.8,
    );
    if (partition.compressEnd <= partition.historyStart) {
      return { messages };
    }

    const previous = messages[partition.frozenEnd]?.memory;
    const compressed = messages.slice(partition.historyStart, partition.compressEnd);
    const promptMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You compress the working memory of an automated code review agent. From the transcript (and the previous summary, if given, which you must fold in), write one concise, factual plain-text summary of what was learned: (1) facts the code and search results revealed, with file:line references; (2) hypotheses verified or ruled out, with the evidence; (3) suspected issues not yet reported and what remains to check. Do not list which tools were called or which comments were submitted; both are recorded separately. No code fences.",
      },
      {
        role: "user",
        content:
          (previous ? `<previous_summary>\n${previous.summary}\n</previous_summary>\n\n` : "") +
          `<transcript>\n${serializeTranscript(compressed)}\n</transcript>\n\nProvide the summary:`,
      },
    ];

    try {
      const resp = await this.llmClient.chatCompletion(promptMessages, undefined, options.signal, {
        timeoutMs: options.timeoutMs,
      });
      const summary = resp.content.trim();
      if (!summary) return { messages, usage: resp.usage };

      const memory: CompressedMemory = {
        actions: [...(previous?.actions ?? []), ...extractActions(compressed)],
        summary,
      };
      return {
        messages: [
          ...messages.slice(0, partition.frozenEnd),
          { role: "user", content: renderMemory(memory), memory },
          ...messages.slice(partition.compressEnd),
        ],
        usage: resp.usage,
      };
    } catch (err) {
      // Cancellation must stop the run; any other failure leaves the conversation as it was.
      if (options.signal?.aborted) throw err;
      return { messages };
    }
  }
}
