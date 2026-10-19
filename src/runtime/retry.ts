import { APIConnectionError } from "openai";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export function isRetriableError(err: unknown): boolean {
  if (!err) return false;
  // OpenAI-compatible SDK errors carry an HTTP status; connection errors and timeouts have none.
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e.status === "number") {
    return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  }
  // Covers APIConnectionTimeoutError (per-request timeout) as well.
  if (err instanceof APIConnectionError) return true;
  if (
    e.code &&
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(e.code)
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|socket hang up|timed out|overloaded/i.test(msg);
}

/**
 * Executes an async action with exponential backoff and full jitter.
 */
export async function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 10000;
  const factor = options.backoffFactor ?? 2;

  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      return await action(attempt);
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !isRetriableError(err)) {
        throw err;
      }

      // Calculate exponential backoff with full jitter
      const exponentialDelay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
      const jitteredDelay = Math.random() * exponentialDelay;

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout);
          reject(new Error("Operation aborted"));
        };
        const timeout = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, jitteredDelay);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

/**
 * Tracks consecutive tool call failures to prevent infinite failure loops.
 */
export class ToolFailureStreakTracker {
  private streaks = new Map<string, number>();
  private readonly maxConsecutiveFailures: number;

  constructor(maxConsecutiveFailures = 3) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
  }

  private key(taskKey: string, toolName: string): string {
    return `${taskKey}::${toolName}`;
  }

  public recordFailure(taskKey: string, toolName: string): boolean {
    const k = this.key(taskKey, toolName);
    const count = (this.streaks.get(k) || 0) + 1;
    this.streaks.set(k, count);
    return count >= this.maxConsecutiveFailures;
  }

  public reset(taskKey: string, toolName: string): void {
    this.streaks.delete(this.key(taskKey, toolName));
  }

  public isTripwire(taskKey: string, toolName: string): boolean {
    return (this.streaks.get(this.key(taskKey, toolName)) || 0) >= this.maxConsecutiveFailures;
  }
}
