import { expect, it } from "vitest";
import { estimateRecordCost, PRICE_DATE, PRICE_TABLE } from "../src/tokens/pricing.js";
import type { TokenUsageRecord } from "../src/types.js";

const record = (provider: string, model: string, extra: Partial<TokenUsageRecord> = {}): TokenUsageRecord => ({
  timestamp: Date.now(), provider, model, input: 1_000_000, output: 100_000,
  reasoning: 50_000, cacheRead: 200_000, cacheWrite: 0, totalTokens: 1_300_000, ...extra,
});

it("prices gpt-6-sol input, cached input, output and cache writes without double-counting reasoning", () => {
  const usage = record("openai-codex", "gpt-6-sol", { input: 100_000, cacheRead: 200_000, cacheWrite: 10_000 });
  // 310k prompt tokens: full-request long-context tier ($4/$0.40/$5/$15).
  expect(estimateRecordCost(usage)).toBeCloseTo((100_000 * 4 + 200_000 * 0.4 + 10_000 * 5 + 100_000 * 15) / 1e6);
  expect(estimateRecordCost({ ...usage, reasoning: 0 })).toBe(estimateRecordCost(usage));
  expect(estimateRecordCost(record("openai-codex", "gpt-6-sol", { input: 10_000, cacheRead: 0, output: 1000 })))
    .toBeCloseTo((10_000 * 2 + 1000 * 10) / 1e6);
});

it("uses exact provider/model matching, Gemini high-context rates, and conservative unknown handling", () => {
  expect(estimateRecordCost(record("antigravity", "gemini-3.1-pro-preview", { input: 210_000, cacheRead: 0, output: 10_000 })))
    .toBeCloseTo((210_000 * 4 + 10_000 * 18) / 1e6);
  expect(estimateRecordCost(record("antigravity", "claude-sonnet-5-thinking", { input: 1000, cacheRead: 1000, cacheWrite: 1000, output: 1000 })))
    .toBeCloseTo((1000 * 2 + 1000 * 0.2 + 1000 * 2.5 + 1000 * 10) / 1e6);
  expect(estimateRecordCost(record("antigravity", "gpt-6-sol"))).toBeUndefined();
  expect(estimateRecordCost(record("openai-codex", "unknown"))).toBeUndefined();
  expect(estimateRecordCost(record("openai-codex", "gpt-5.4", { cacheWrite: 1 }))).toBeUndefined();
  expect(estimateRecordCost(record("antigravity", "gemini-3-flash-preview", { cacheWrite: 1 }))).toBeUndefined();
});

it("publishes a dated, official-source price catalogue", () => {
  expect(PRICE_DATE).toBe("2026-09-23");
  expect(PRICE_TABLE.map((row) => [row.provider, row.model]).length).toBeGreaterThanOrEqual(12);
  for (const row of PRICE_TABLE) {
    expect(row.source).toMatch(/^https:\/\/(developers\.openai\.com|ai\.google\.dev|platform\.claude\.com)\//);
  }
});
