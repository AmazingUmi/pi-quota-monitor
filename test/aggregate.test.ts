import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { localDate } from "../src/tokens/store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "quota-aggregate-")); directories.push(dir); return dir; }
function entry(day: string, provider = "openai-codex", model = "same", totalTokens = 17) {
  return { timestamp: new Date(`${day}T12:00:00`).getTime(), provider, model,
    input: 10, output: 5, reasoning: 3, cacheRead: 1, cacheWrite: 1, totalTokens };
}
const day = localDate(Date.now());
const yesterday = localDate(Date.now() - 86400_000);
const line = (value: unknown) => JSON.stringify(value) + "\n";

it("groups all dates by provider and model, sorts by ledger total, and never adds reasoning twice", async () => {
  const dir = await fixture();
  await writeFile(join(dir, `usage-${yesterday}.jsonl`), line(entry(yesterday)));
  await writeFile(join(dir, `usage-${day}.jsonl`), line(entry(day)) + line(entry(day, "antigravity", "same", 23)));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  const { totals, models, records } = aggregator.state();
  expect(records).toBe(3);
  expect(totals).toEqual({ input: 30, output: 15, reasoning: 9, cacheRead: 3, cacheWrite: 3, totalTokens: 57 });
  expect(models.map(({ provider, model, totalTokens }) => [provider, model, totalTokens])).toEqual([
    ["openai-codex", "same", 34], ["antigravity", "same", 23],
  ]);
  expect(models.reduce((sum, item) => sum + item.totalTokens, 0)).toBe(totals.totalTokens);
  expect(aggregator.state().timeline.days.filter((item) => item.bucket === day).map((item) => [item.provider, item.totalTokens])).toEqual([
    ["antigravity", 23], ["openai-codex", 17],
  ]);
  aggregator.stop();
});

it("sums per-record API-price estimates and keeps unknown models unpriced", async () => {
  const dir = await fixture();
  const path = join(dir, `usage-${day}.jsonl`);
  await writeFile(path, line({ ...entry(day, "openai-codex", "gpt-6-sol"), input: 1_000_000, output: 100_000, reasoning: 50_000,
    cacheRead: 200_000, cacheWrite: 0, totalTokens: 1_300_000 })
    + line({ ...entry(day, "antigravity", "gemini-3.8-flash"), input: 10_000, output: 1000, reasoning: 0, cacheRead: 20_000, cacheWrite: 0, totalTokens: 11_000, pricingAsOf: "2026-09-23" })
    + line(entry(day, "antigravity", "unknown")));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  const { pricing, models } = aggregator.state();
  expect(pricing).toMatchObject({ pricedRecords: 2, unpricedRecords: 1, unpricedTokens: 17 });
  const gptCost = (1_000_000 * 4 + 200_000 * 0.4 + 100_000 * 15) / 1e6;
  const geminiCost = (10_000 * 0.75 + 20_000 * 0.075 + 1000 * 3.75) / 1e6;
  expect(pricing.estimatedCostUsd).toBeCloseTo(gptCost + geminiCost);
  expect(models.find((item) => item.model === "gemini-3.8-flash")).toMatchObject({ pricedRecords: 1, unpricedRecords: 0, estimatedCostUsd: geminiCost });
  expect(models.find((item) => item.model === "unknown")).toMatchObject({ pricedRecords: 0, unpricedRecords: 1, estimatedCostUsd: 0 });
  await aggregator.refresh();
  expect(aggregator.state().pricing).toEqual(pricing);
  const restarted = new UsageAggregator(dir);
  await restarted.refresh();
  expect(restarted.state().pricing).toEqual(pricing);
});

it("keeps hourly and daily cost trends aligned with accountId-filtered usage", async () => {
  const dir = await fixture();
  const timestamp = Date.now() - 60_000;
  const usageDay = localDate(timestamp);
  const record = (provider: string, model: string, accountId?: string) => ({
    ...entry(usageDay, provider, model), timestamp, input: 1_000_000, output: 0, reasoning: 0,
    cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000, ...(accountId ? { accountId } : {}),
  });
  await writeFile(join(dir, `usage-${usageDay}.jsonl`), [
    record("openai-codex", "gpt-6-sol", "obr-id"),
    record("openai-codex", "gpt-6-sol", "other-id"),
    record("openai-codex", "unknown", "obr-id"),
    record("openai-codex", "gpt-6-sol"),
    record("antigravity", "gemini-2.5-flash"),
  ].map(line).join(""));
  const obr = new UsageAggregator(dir, "obr-id");
  const other = new UsageAggregator(dir, "other-id");
  const legacy = new UsageAggregator(dir, null);
  for (const aggregator of [obr, other, legacy]) await aggregator.refresh();
  expect([obr.state().records, other.state().records, legacy.state().records]).toEqual([3, 2, 2]);
  for (const period of ["hours", "days"] as const) {
    const cost = (view: UsageAggregator) => view.state().timeline[period].reduce((sum, item) => sum + item.estimatedCostUsd, 0);
    expect(cost(obr)).toBeCloseTo(4.3);
    expect(cost(other)).toBeCloseTo(4.3);
    expect(cost(legacy)).toBeCloseTo(4.3);
    expect(obr.state().timeline[period].filter((item) => item.provider === "openai-codex")
      .reduce((sum, item) => sum + item.unpricedRecords, 0)).toBe(1);
  }
  expect(obr.state().pricing).toMatchObject({ estimatedCostUsd: 4.3, pricedRecords: 2, unpricedRecords: 1 });
  expect(obr.state().totals.totalTokens).toBe(3_000_000);
  expect(obr.estimateCostForPeriod("openai-codex", timestamp - 1, timestamp + 1).estimatedCostUsd).toBe(4);
  await obr.refresh();
  expect(obr.state().timeline.hours.reduce((sum, item) => sum + item.estimatedCostUsd, 0)).toBeCloseTo(4.3);
  await appendFile(join(dir, `usage-${usageDay}.jsonl`), line(record("openai-codex", "gpt-6-sol", "other-id")));
  await obr.refresh();
  await other.refresh();
  expect(obr.state().pricing.estimatedCostUsd).toBeCloseTo(4.3);
  expect(other.state().timeline.hours.reduce((sum, item) => sum + item.estimatedCostUsd, 0)).toBeCloseTo(8.3);
});

it("aggregates priced and unpriced provider costs within exact quota-period boundaries", async () => {
  const dir = await fixture();
  const timestamp = Date.now() - 60_000;
  const usageDay = localDate(timestamp);
  const codex = { ...entry(usageDay, "openai-codex", "gpt-6-sol"), timestamp,
    input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 };
  const antigravity = { ...entry(usageDay, "antigravity", "gemini-2.5-flash"), timestamp,
    input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 };
  const unknown = { ...entry(usageDay, "openai-codex", "unknown-model"), timestamp,
    input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
  await writeFile(join(dir, `usage-${usageDay}.jsonl`), [codex, antigravity, unknown].map(line).join(""));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  expect(aggregator.estimateCostForPeriod("openai-codex", timestamp - 1, timestamp + 1)).toEqual({
    totalTokens: 1_000_010, estimatedCostUsd: 4, pricedRecords: 1, unpricedRecords: 1, unpricedTokens: 10,
  });
  expect(aggregator.estimateCostForPeriod("antigravity", timestamp - 1, timestamp + 1)).toEqual({
    totalTokens: 1_000_000, estimatedCostUsd: 0.3, pricedRecords: 1, unpricedRecords: 0, unpricedTokens: 0,
  });
  expect(aggregator.estimateCostForPeriod("openai-codex", timestamp, timestamp + 1).pricedRecords).toBe(1);
  expect(aggregator.estimateCostForPeriod("openai-codex", timestamp + 1, timestamp + 2).pricedRecords).toBe(0);
  expect(aggregator.estimateCostForPeriod("openai-codex", timestamp - 1, timestamp).pricedRecords).toBe(0);
});

it("retains recorded amounts and filters exact-timestamp observations by model pool", async () => {
  const dir = await fixture();
  const timestamp = Date.now() - 60_000;
  const usageDay = localDate(timestamp);
  const records = [
    { ...entry(usageDay, "antigravity", "gemini-2.5-flash"), timestamp, estimatedCostUsd: 3, pricingAsOf: "old-price" },
    { ...entry(usageDay, "antigravity", "claude-sonnet-5"), timestamp, estimatedCostUsd: 7, pricingAsOf: "old-price" },
  ];
  await writeFile(join(dir, `usage-${usageDay}.jsonl`), records.map(line).join(""));
  const view = new UsageAggregator(dir);
  await view.refresh();
  expect(view.state().pricing.estimatedCostUsd).toBe(10);
  expect(view.estimateCostForPeriod("antigravity", timestamp, timestamp + 1, (model) => model.startsWith("gemini-")))
    .toMatchObject({ totalTokens: 17, estimatedCostUsd: 3, pricedRecords: 1 });
  const restarted = new UsageAggregator(dir);
  await restarted.refresh();
  expect(restarted.state().pricing.estimatedCostUsd).toBe(10);
});

it("holds incomplete lines, skips damaged records, and processes external appends exactly once", async () => {
  const dir = await fixture();
  const path = join(dir, `usage-${day}.jsonl`);
  await writeFile(path, "{broken}\n" + line(entry(day)) + JSON.stringify(entry(day, "antigravity")).slice(0, 32));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  expect(aggregator.state()).toMatchObject({ records: 1, invalidRecords: 1, stale: false });
  const partial = JSON.stringify(entry(day, "antigravity"));
  await appendFile(path, partial.slice(32) + "\n" + line({ ...entry(day), totalTokens: "bad" }));
  await aggregator.refresh();
  await aggregator.refresh();
  expect(aggregator.state()).toMatchObject({ records: 2, invalidRecords: 2, totals: { totalTokens: 34 } });
  await writeFile(join(dir, `usage-${yesterday}.jsonl`), line(entry(yesterday)));
  await aggregator.refresh();
  expect(aggregator.state().records).toBe(3);
  aggregator.stop();
  const restarted = new UsageAggregator(dir);
  await restarted.refresh();
  expect(restarted.state().totals).toEqual(aggregator.state().totals);
  await writeFile(path, line(entry(day, "antigravity", "new", 9)));
  await restarted.refresh();
  expect(restarted.state()).toMatchObject({ records: 2, invalidRecords: 0, totals: { totalTokens: 26 } });
});

it("incrementally updates hourly series per provider/model without counting half-written lines", async () => {
  const dir = await fixture();
  const path = join(dir, `usage-${day}.jsonl`);
  const timestamp = Date.now();
  const a = { ...entry(day), timestamp };
  const b = { ...entry(day, "antigravity", "same", 23), timestamp };
  await writeFile(path, line(a) + JSON.stringify(b).slice(0, 20));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  expect(aggregator.state().timeline.hours).toMatchObject([{ provider: "openai-codex", totalTokens: 17 }]);
  await appendFile(path, JSON.stringify(b).slice(20) + "\n");
  await aggregator.refresh();
  await aggregator.refresh();
  expect(aggregator.state().timeline.hours.map((item) => [item.provider, item.totalTokens])).toEqual([
    ["antigravity", 23], ["openai-codex", 17],
  ]);
});

it("does not count a trailing half-written record until its newline, including after restart", async () => {
  const dir = await fixture();
  const path = join(dir, `usage-${day}.jsonl`);
  const value = JSON.stringify(entry(day));
  await writeFile(path, value.slice(0, 20));
  const first = new UsageAggregator(dir);
  await first.refresh();
  expect(first.state()).toMatchObject({ records: 0, invalidRecords: 0 });
  const restarted = new UsageAggregator(dir);
  await restarted.refresh();
  expect(restarted.state().records).toBe(0);
  await appendFile(path, value.slice(20) + "\n");
  await first.refresh();
  await restarted.refresh();
  expect(first.state().totals).toEqual(restarted.state().totals);
  expect(restarted.state().records).toBe(1);
});

it("returns an empty result for a missing directory and retains a stale snapshot on failure", async () => {
  const dir = await fixture();
  const aggregator = new UsageAggregator(join(dir, "absent"));
  await aggregator.refresh();
  expect(aggregator.state()).toMatchObject({ records: 0, invalidRecords: 0, stale: false, models: [] });
  const path = join(dir, `usage-${day}.jsonl`);
  await writeFile(path, line(entry(day)));
  const reader = new UsageAggregator(dir);
  await reader.refresh();
  const before = reader.state();
  await rm(path);
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await reader.refresh();
  expect(reader.state()).toMatchObject({ records: 1, stale: true, totals: before.totals });
  expect(reader.state().error).not.toContain(dir);
  await rm(dir);
  await reader.refresh();
  expect(reader.state()).toMatchObject({ records: 0, stale: false });
  expect(reader.state().error).toBeUndefined();
});
