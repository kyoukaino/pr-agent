import { describe, it, expect } from "vite-plus/test";
import { computeCostUsd, getModelPricing, isPeakHour } from "./pricing.js";

describe("DeepSeek pricing", () => {
  it("recognizes peak hours (UTC, weekdays only)", () => {
    expect(isPeakHour(new Date("2026-10-19T02:30:00Z"))).toBe(true); // Monday 02:30
    expect(isPeakHour(new Date("2026-10-19T05:00:00Z"))).toBe(false); // gap between windows
    expect(isPeakHour(new Date("2026-10-19T09:59:00Z"))).toBe(true);
    expect(isPeakHour(new Date("2026-10-19T10:00:00Z"))).toBe(false);
    expect(isPeakHour(new Date("2026-10-18T02:30:00Z"))).toBe(false); // Sunday
  });

  it("bills cache hits, cache misses and output separately, halved off-peak", () => {
    const pricing = getModelPricing("deepseek-v4-pro");
    const usage = { promptTokens: 1_000_000, cacheHitTokens: 800_000, completionTokens: 100_000 };
    // 0.8M * 0.044 + 0.2M * 1.32 + 0.1M * 3.96
    const peak = 0.0352 + 0.264 + 0.396;
    expect(computeCostUsd(pricing, usage, new Date("2026-10-19T02:00:00Z"))).toBeCloseTo(peak, 6);
    expect(computeCostUsd(pricing, usage, new Date("2026-10-19T12:00:00Z"))).toBeCloseTo(
      peak / 2,
      6,
    );
  });

  it("refuses models without pricing instead of reporting zero cost", () => {
    expect(() => getModelPricing("deepseek-chat")).toThrow(/No pricing/);
  });
});
