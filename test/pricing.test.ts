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

it("prices DeepSeek's cache hits, misses, peak windows, weekends and Chinese public holidays", () => {
  const at = (iso: string, model = "deepseek-flash") => record("deepseek", model, {
    timestamp: Date.parse(iso), input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 10_000,
  });
  const offPeak = (0.15 + 0.6 * 0.1 + 0.003 * 0.2 + 0.15 * 0.01);
  const peak = offPeak * 2;
  expect(estimateRecordCost(at("2026-09-24T00:59:59Z"))).toBeCloseTo(offPeak);
  expect(estimateRecordCost(at("2026-09-24T01:00:00Z"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T03:59:59Z"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T04:00:00Z"))).toBeCloseTo(offPeak);
  expect(estimateRecordCost(at("2026-09-24T06:00:00Z"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T10:00:00Z"))).toBeCloseTo(offPeak);
  expect(estimateRecordCost(at("2026-09-25T01:00:00Z"))).toBeCloseTo(offPeak); // Mid-Autumn holiday
  expect(estimateRecordCost(at("2026-09-26T01:00:00Z"))).toBeCloseTo(offPeak); // Saturday
  expect(estimateRecordCost(at("2026-09-28T01:00:00Z"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T06:00:00Z", "deepseek-v4-flash"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T01:00:00Z", "deepseek-v4-flash-vision-exp"))).toBeCloseTo(peak);
  expect(estimateRecordCost(at("2026-09-24T01:00:00Z", "deepseek-v4-pro")))
    .toBeCloseTo(1.32 + 3.96 * 0.1 + 0.044 * 0.2 + 1.32 * 0.01);
  expect(estimateRecordCost(at("2026-09-24T01:00:00Z", "deepseek-chat"))).toBeUndefined();
  expect(estimateRecordCost({ ...at("2026-09-24T01:00:00Z"), timestamp: NaN })).toBeUndefined();
});

it("prices direct providers and newer model rates, including dated Gemini promotions", () => {
  expect(estimateRecordCost(record("openai", "gpt-5.6-sol", { input: 100_000, cacheRead: 200_000, cacheWrite: 10_000 })))
    .toBeCloseTo((100_000 * 8 + 200_000 * 0.8 + 10_000 * 10 + 100_000 * 30) / 1e6);
  expect(estimateRecordCost(record("openai", "gpt-5.6", { input: 10_000, cacheRead: 2000, output: 1000 })))
    .toBeCloseTo((10_000 * 4 + 2000 * 0.4 + 1000 * 20) / 1e6);
  expect(estimateRecordCost(record("openai-codex", "gpt-5.6-cyber", { input: 10_000, cacheRead: 1000, cacheWrite: 1000 })))
    .toBeCloseTo((10_000 * 12.5 + 1000 * 1.25 + 1000 * 15.625 + 100_000 * 75) / 1e6);
  expect(estimateRecordCost(record("anthropic", "claude-fable-5-1", { input: 1000, cacheRead: 1000, cacheWrite: 1000, output: 1000 })))
    .toBeCloseTo((1000 * 10 + 1000 * 0.25 + 1000 * 12.5 + 1000 * 50) / 1e6);
  expect(estimateRecordCost(record("google", "gemini-3.7-flash", { timestamp: Date.UTC(2026, 11, 31) })))
    .toBeCloseTo(0.75 + 0.075 * 0.2 + 3.75 * 0.1);
  expect(estimateRecordCost(record("google", "gemini-3.7-flash", { timestamp: Date.UTC(2027, 0, 1) })))
    .toBeCloseTo(1.5 + 0.15 * 0.2 + 7.5 * 0.1);
  expect(estimateRecordCost(record("google", "gemini-2.5-flash-lite")))
    .toBeCloseTo(0.1 + 0.01 * 0.2 + 0.4 * 0.1);
  expect(estimateRecordCost(record("google-vertex", "gemini-2.5-flash"))).toBeUndefined();
  expect(estimateRecordCost(record("antigravity", "claude-fable-5-1", { cacheWrite: 1000 }))).toBeDefined();
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
  expect(PRICE_TABLE.map((row) => [row.provider, row.model]).length).toBeGreaterThanOrEqual(60);
  for (const row of PRICE_TABLE) {
    expect(row.source).toMatch(/^https:\/\/(developers\.openai\.com|ai\.google\.dev|platform\.claude\.com|cloud\.google\.com|api-docs\.deepseek\.com)\//);
  }
});
