import { expect, it } from "vitest";
import { estimateRecordCost, PRICE_DATE, PRICE_TABLE } from "../src/tokens/pricing.js";
import type { TokenUsageRecord } from "../src/types.js";
import { tokenRecord } from "../src/tokens/collector.js";

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
  expect(estimateRecordCost(record("antigravity", "gemini-3.8-flash", { input: 10_000, cacheRead: 20_000, output: 1000 })))
    .toBeCloseTo((10_000 * 0.75 + 20_000 * 0.075 + 1000 * 3.75) / 1e6);
  expect(estimateRecordCost(record("antigravity", "gemini-3.8-flash-high", { input: 10_000, cacheRead: 20_000, output: 1000 })))
    .toBeCloseTo((10_000 * 0.75 + 20_000 * 0.075 + 1000 * 3.75) / 1e6);
  expect(estimateRecordCost(record("antigravity", "gemini-3.8-flash-image"))).toBeUndefined();
  expect(estimateRecordCost(record("google-vertex", "gemini-3.8-flash", { input: 10_000, cacheRead: 20_000, output: 1000 })))
    .toBeCloseTo((10_000 * 0.75 + 20_000 * 0.075 + 1000 * 3.75) / 1e6);
  expect(estimateRecordCost(record("google-vertex", "gemini-3.8-flash", {
    timestamp: Date.UTC(2027, 0, 1), input: 10_000, cacheRead: 20_000, output: 1000,
  }))).toBeCloseTo((10_000 * 1.5 + 20_000 * 0.15 + 1000 * 7.5) / 1e6);
  expect(estimateRecordCost(record("google-vertex", "gemini-3.8-flash-high"))).toBeUndefined();
  expect(estimateRecordCost(record("google-vertex", "gemini-3.8-flash", { cacheWrite: 1 }))).toBeUndefined();
  expect(estimateRecordCost(record("antigravity", "gpt-6-sol"))).toBeUndefined();
  expect(estimateRecordCost(record("openai-codex", "unknown"))).toBeUndefined();
  expect(estimateRecordCost(record("openai-codex", "gpt-5.4", { cacheWrite: 1 }))).toBeUndefined();
  expect(estimateRecordCost(record("antigravity", "gemini-3-flash-preview", { cacheWrite: 1 }))).toBeUndefined();
});

it("freezes the collected cost, preserves recorded amounts, and retroactively prices unpriced records", () => {
  const usage = record("openai-codex", "gpt-6-sol");
  const saved = tokenRecord({ role: "assistant", provider: usage.provider, model: usage.model, api: "openai-codex-responses",
    timestamp: usage.timestamp, content: [], stopReason: "stop", usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  expect(saved).toMatchObject({ pricingAsOf: PRICE_DATE, estimatedCostUsd: estimateRecordCost(usage) });
  const vertexUsage = { ...usage, provider: "google-vertex", model: "gemini-3.8-flash", cacheWrite: 0 };
  const vertexSaved = tokenRecord({ role: "assistant", provider: vertexUsage.provider, model: vertexUsage.model, api: "google-generative-ai",
    timestamp: vertexUsage.timestamp, content: [], stopReason: "stop", usage: { ...vertexUsage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  expect(vertexSaved).toMatchObject({ pricingAsOf: PRICE_DATE, estimatedCostUsd: estimateRecordCost(vertexUsage) });
  expect(estimateRecordCost({ ...usage, estimatedCostUsd: 17, pricingAsOf: "older-price" })).toBe(17);
  expect(estimateRecordCost({ ...usage, estimatedCostUsd: 0, pricingAsOf: "older-price" })).toBe(0);
  expect(estimateRecordCost({ ...usage, pricingAsOf: "older-price" })).toBeUndefined();
  expect(estimateRecordCost({ ...usage, provider: "antigravity", model: "gemini-3.8-flash", pricingAsOf: "older-price" }))
    .toBeCloseTo(estimateRecordCost({ ...usage, provider: "antigravity", model: "gemini-3.8-flash" })!);
  expect(estimateRecordCost({ ...usage, provider: "google-vertex", model: "gemini-3.8-flash", pricingAsOf: "older-price" }))
    .toBeCloseTo(estimateRecordCost({ ...usage, provider: "google-vertex", model: "gemini-3.8-flash" })!);
  expect(estimateRecordCost({ ...usage, model: "unknown-model", pricingAsOf: "older-price" })).toBeUndefined();
  expect(estimateRecordCost({ ...usage, estimatedCostUsd: -1 })).toBeUndefined();
});

it("publishes a dated, official-source price catalogue", () => {
  expect(PRICE_DATE).toBe("2026-09-25");
  expect(PRICE_TABLE.map((row) => [row.provider, row.model]).length).toBeGreaterThanOrEqual(12);
  for (const row of PRICE_TABLE) {
    expect(row.source).toMatch(/^https:\/\/(developers\.openai\.com|ai\.google\.dev|platform\.claude\.com|cloud\.google\.com)\//);
  }
});
