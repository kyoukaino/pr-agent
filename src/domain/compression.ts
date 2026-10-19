import type { ChatMessage } from "../runtime/types.js";
import type { DeepSeekLLMClient, LLMResponse } from "../llm/client.js";
import { countMessagesTokens } from "../runtime/budget.js";

interface Round {
  assistantIdx: number;
  toolIdxs: number[];
}

export interface PartitionResult {
  frozenEnd: number;
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
  const result: PartitionResult = {
    frozenEnd: Math.min(messages.length, 2),
    compressEnd: messages.length,
    rounds: [],
    activeCount: 0,
  };

  if (messages.length <= 2) {
    return result;
  }

  const rounds = groupIntoRounds(messages, 2);
  result.rounds = rounds;
  if (rounds.length === 0) {
    return result;
  }

  // Recent rounds kept verbatim get half of the warning limit, minus the frozen prompt, so that
  // frozen + summary + active lands well below the trigger instead of re-triggering immediately.
  const frozenTokens = countMessagesTokens(messages.slice(0, result.frozenEnd));
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
    result.compressEnd = result.frozenEnd;
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

/**
 * Lists the code_comment calls in the range that were accepted, straight from the transcript, so the
 * record of what was already reported survives compression regardless of summary quality.
 */
export function extractSubmittedComments(messages: ChatMessage[]): string[] {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content);
  }
  const submitted: string[] = [];
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.function.name !== "code_comment") continue;
      if (!results.get(tc.id)?.startsWith("Comment recorded")) continue;
      try {
        const a = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        submitted.push(`- [${a.severity ?? "?"}] ${a.path}:${a.line}: ${a.title ?? ""}`);
      } catch {
        // an unparseable call could not have been recorded
      }
    }
  }
  return submitted;
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

/**
 * Three-zone Memory Compressor.
 * Keeps the Frozen zone (system prompt + task) intact, replaces the Compress zone with a summary of
 * the trajectory plus a verbatim list of submitted comments, and keeps the Active zone (most recent
 * rounds) intact.
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
    if (partition.compressEnd <= partition.frozenEnd) {
      return { messages };
    }

    const compressed = messages.slice(partition.frozenEnd, partition.compressEnd);
    const promptMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You compress the working memory of an automated code review agent. From the transcript, write a concise, factual plain-text summary covering: (1) files and line ranges already read and searches already run, with what they revealed; (2) hypotheses verified or ruled out, with the evidence; (3) suspected issues not yet reported and what remains to check. Do not restate submitted comments; they are listed separately. No code fences.",
      },
      {
        role: "user",
        content: `<transcript>\n${serializeTranscript(compressed)}\n</transcript>\n\nProvide the summary:`,
      },
    ];

    try {
      const resp = await this.llmClient.chatCompletion(promptMessages, undefined, options.signal, {
        timeoutMs: options.timeoutMs,
      });
      const summaryText = resp.content.trim();
      if (!summaryText) return { messages, usage: resp.usage };

      const submitted = extractSubmittedComments(compressed);
      let memory = `<previous_review_summary>\n${summaryText}\n</previous_review_summary>`;
      if (submitted.length > 0) {
        memory += `\n\n<comments_already_submitted>\n${submitted.join("\n")}\n(Do NOT submit these again.)\n</comments_already_submitted>`;
      }

      return {
        messages: [
          messages[0],
          { role: "user", content: `${messages[1].content}\n\n${memory}` },
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
