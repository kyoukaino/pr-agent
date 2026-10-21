/**
 * DeepSeek API pricing in USD per 1M tokens at peak rates (https://api-docs.deepseek.com/quick_start/pricing).
 * The API returns token usage but no cost, so cost is computed here from the cache hit/miss split.
 */
export interface ModelPricing {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  /** Whether the provider offers an off-peak discount (e.g. DeepSeek off-peak halving). */
  hasOffPeakDiscount?: boolean;
}

export const DEEPSEEK_PEAK_PRICING_USD = {
  "deepseek-flash": {
    inputCacheHit: 0.006,
    inputCacheMiss: 0.3,
    output: 1.2,
    hasOffPeakDiscount: true,
  },
  "deepseek-v4-pro": {
    inputCacheHit: 0.044,
    inputCacheMiss: 1.32,
    output: 3.96,
    hasOffPeakDiscount: true,
  },
} satisfies Record<string, ModelPricing>;

export const KNOWN_MODEL_PRICINGS_USD: Record<string, ModelPricing> = {
  ...DEEPSEEK_PEAK_PRICING_USD,
  "claude-3-5-sonnet-20241022": { inputCacheHit: 0.3, inputCacheMiss: 3.0, output: 15.0 },
  "claude-3-7-sonnet-20250219": { inputCacheHit: 0.3, inputCacheMiss: 3.0, output: 15.0 },
  "gpt-4o": { inputCacheHit: 1.25, inputCacheMiss: 2.5, output: 10.0 },
  "gpt-4o-mini": { inputCacheHit: 0.075, inputCacheMiss: 0.15, output: 0.6 },
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from DeepSeek's context cache (billed at the cache-hit rate). */
  cacheHitTokens: number;
  costUsd: number;
}

export function tryGetModelPricing(model: string): ModelPricing | undefined {
  return (
    KNOWN_MODEL_PRICINGS_USD[model] ||
    (DEEPSEEK_PEAK_PRICING_USD as Record<string, ModelPricing>)[model]
  );
}

export function getModelPricing(model: string): ModelPricing {
  const pricing = (DEEPSEEK_PEAK_PRICING_USD as Record<string, ModelPricing>)[model];
  if (!pricing) {
    const known = Object.keys(DEEPSEEK_PEAK_PRICING_USD).join(", ");
    throw new Error(
      `No pricing for model '${model}' (known: ${known}); cost budget cannot be enforced`,
    );
  }
  return pricing;
}

/**
 * Peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; off-peak is half price.
 * Chinese public holidays (also off-peak) are not modelled, so those calls are over- rather than under-counted.
 */
export function isPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function computeCostUsd(
  pricing: ModelPricing,
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number },
  at = new Date(),
): number {
  const cacheMiss = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const peakCost =
    (usage.cacheHitTokens * pricing.inputCacheHit +
      cacheMiss * pricing.inputCacheMiss +
      usage.completionTokens * pricing.output) /
    1_000_000;
  if (!pricing.hasOffPeakDiscount) {
    return peakCost;
  }
  return isPeakHour(at) ? peakCost : peakCost / 2;
}
