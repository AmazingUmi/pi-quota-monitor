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
    cacheRead: 200_000, cacheWrite: 0, totalTokens: 1_300_000 }) + line(entry(day, "antigravity", "unknown")));
  const aggregator = new UsageAggregator(dir);
  await aggregator.refresh();
  const { pricing, models } = aggregator.state();
  expect(pricing).toMatchObject({ pricedRecords: 1, unpricedRecords: 1, unpricedTokens: 17 });
  expect(pricing.estimatedCostUsd).toBeCloseTo((1_000_000 * 4 + 200_000 * 0.4 + 100_000 * 15) / 1e6);
  expect(models.find((item) => item.model === "unknown")).toMatchObject({ pricedRecords: 0, unpricedRecords: 1, estimatedCostUsd: 0 });
  await aggregator.refresh();
  expect(aggregator.state().pricing).toEqual(pricing);
  const restarted = new UsageAggregator(dir);
  await restarted.refresh();
  expect(restarted.state().pricing).toEqual(pricing);
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
