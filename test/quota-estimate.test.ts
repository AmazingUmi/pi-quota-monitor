import { expect, it, vi } from "vitest";
import { antigravityWindowDuration, estimateQuotaAmount, FIVE_HOURS_MS, ONE_WEEK_MS, quotaAmountEstimates, type WindowReading } from "../src/quota-estimate.js";
import type { UsageAggregator } from "../src/tokens/aggregate.js";

const now = Date.parse("2026-09-23T12:00:00Z");
const resetAt = now + 2 * 3_600_000;
const cost = { totalTokens: 1000, estimatedCostUsd: 8, pricedRecords: 4, unpricedRecords: 0, unpricedTokens: 0 };
const sample = (capturedAt: number, remainingPercent: number, reset = resetAt): WindowReading => ({ capturedAt, window: { label: "5h", remainingPercent, resetAt: reset } });

it("uses only observed percentage-point changes and costs within the recorded timestamps", () => {
  const from = now - 3600_000;
  const end = now - 60_000;
  const costForPeriod = vi.fn(() => cost);
  const result = estimateQuotaAmount([sample(from, 70), sample(end, 60)], FIVE_HOURS_MS, costForPeriod, now);
  expect(costForPeriod).toHaveBeenCalledExactlyOnceWith(from, end);
  expect(result).toMatchObject({ observedCostUsd: 8, observedTokens: 1000, usedPercent: 10,
    estimatedPeriodUsd: 80, estimatedRemainingUsd: 48, sampleStartAt: from, sampleEndAt: end });
  // The old algorithm would divide by all 40% consumed, including time before installation.
  expect(result.estimatedPeriodUsd).not.toBe(20);
});

it("recognizes supported Antigravity windows without inventing other periods", () => {
  expect(antigravityWindowDuration("Five Hour Limit Remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("5-hour limit remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("Weekly Limit Remaining")).toBe(ONE_WEEK_MS);
  expect(antigravityWindowDuration("Daily requests")).toBeUndefined();
});

it("does not extrapolate from one reading, zero change, expired/missing windows or incomplete costs", () => {
  const readings = [sample(now - 3600_000, 70), sample(now, 60)];
  const estimate = (rows = readings, summary = cost, stale = false) => estimateQuotaAmount(rows, FIVE_HOURS_MS, () => summary, now, stale);
  expect(estimate([]).estimatedPeriodUsd).toBeUndefined();
  expect(estimate([readings[1]]).note).toContain("第二次");
  expect(estimate([sample(now - 3600_000, 60), readings[1]]).note).toContain("尚未下降");
  expect(estimate([{ capturedAt: now, window: { label: "5h", remainingPercent: 60 } }]).note).toContain("重置时间");
  expect(estimate([sample(now, 60, now)]).note).toContain("已到重置时间");
  expect(estimate(readings, { ...cost, estimatedCostUsd: 0 }).estimatedPeriodUsd).toBeUndefined();
  expect(estimate(readings, { ...cost, unpricedRecords: 1 }).note).toContain("未计价");
  expect(estimate(readings, cost, true).note).toContain("已过期");
});

it("never crosses a reset or quota increase and accepts small reset timestamp rounding", () => {
  const estimate = (readings: WindowReading[]) => estimateQuotaAmount(readings, FIVE_HOURS_MS, () => cost, now);
  expect(estimate([sample(now - 3600_000, 70, resetAt - FIVE_HOURS_MS), sample(now, 60)]).estimatedPeriodUsd).toBeUndefined();
  expect(estimate([sample(now - 3600_000, 50), sample(now, 60)]).estimatedPeriodUsd).toBeUndefined();
  const result = estimate([sample(now - 7200_000, 40), sample(now - 3600_000, 70), sample(now, 60, resetAt + 1000)]);
  expect(result.sampleStartAt).toBe(now - 3600_000);
  expect(result.estimatedRemainingUsd).toBe(48);
});

it("recalibrates after an early manual increase without crossing into the old OAI period", () => {
  const before = sample(now - 180_000, 30);
  const reset = sample(now - 120_000, 95);
  const after = sample(now - 60_000, 85);
  const periodCost = vi.fn(() => cost);
  const result = estimateQuotaAmount([before, reset, after], ONE_WEEK_MS, periodCost, now, false, true);
  expect(periodCost).toHaveBeenCalledExactlyOnceWith(reset.capturedAt, after.capturedAt);
  expect(result).toMatchObject({ sampleStartAt: reset.capturedAt, estimatedPeriodUsd: 80 });
});

it("estimates within an unusually long OAI period without assuming exactly 7 days", () => {
  const earlier = sample(now - 7 * 86_400_000, 70, now + 3_600_000);
  const later = sample(now, 60, now + 3_600_000);
  const estimate = estimateQuotaAmount([earlier, later], FIVE_HOURS_MS, () => cost, now, false, true);
  expect(estimate).toMatchObject({ sampleStartAt: earlier.capturedAt, estimatedPeriodUsd: 80, estimatedRemainingUsd: 48 });
});

it("filters Antigravity calibration by model pool and does not borrow Codex history when hidden", () => {
  const time = Date.now();
  const start = time - 3600_000;
  const quota = (capturedAt: number, remainingPercent: number) => ({ capturedAt, groups: [
    { name: "Gemini", windows: [{ label: "5h", remainingPercent, resetAt: time + 3600_000 }] },
    { name: "Claude/GPT", windows: [{ label: "5h", remainingPercent, resetAt: time + 3600_000 }] },
  ], models: [] });
  const estimateCostForPeriod = vi.fn(() => cost);
  const aggregator = { state: () => ({ stale: false }), estimateCostForPeriod } as unknown as UsageAggregator;
  const result = quotaAmountEstimates(aggregator, {}, { value: quota(time, 60) }, [], [quota(start, 70)]);
  expect(result.codex.fiveHour.estimatedPeriodUsd).toBeUndefined();
  expect(estimateCostForPeriod).toHaveBeenCalledTimes(2);
  const calls = estimateCostForPeriod.mock.calls as unknown as Array<[string, number, number, (model: string) => boolean]>;
  expect(calls[0].slice(0, 3)).toEqual(["antigravity", start, time]);
  expect(calls[0][3]("gemini-2.5-flash")).toBe(true);
  expect(calls[0][3]("claude-sonnet-5")).toBe(false);
  expect(calls[1][3]("claude-sonnet-5")).toBe(true);
  expect(calls[1][3]("gemini-2.5-flash")).toBe(false);
});
