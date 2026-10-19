export type TaskState = "PENDING" | "RUNNING" | "SUSPENDED" | "COMPLETED" | "FAILED" | "CANCELLED";

export enum MainLoopStop {
  StopNone = "none",
  StopMaxRounds = "max_rounds",
  StopCostBudget = "cost_budget",
  StopEmptyRounds = "empty_rounds",
  StopCompression = "compression",
  StopTimeout = "timeout",
  StopLLMError = "llm_error",
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  /** Set on the compressed-memory message; internal only, never sent to the API. */
  memory?: CompressedMemory;
}

/** Working memory that replaces compressed history; `content` of its message is rendered from it. */
export interface CompressedMemory {
  /** Every compressed tool call in order: `- name {args}`, plus ` → recorded` / ` → Error …`. */
  actions: string[];
  /** LLM summary of what the compressed tool results revealed. */
  summary: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
  error?: string;
  durationMs?: number;
}

export interface AgentRunRecord {
  runId: string;
  sessionKey: string;
  taskState: TaskState;
  startTime: number;
  endTime?: number;
  totalTokensUsed: number;
  stopReason?: MainLoopStop;
}
