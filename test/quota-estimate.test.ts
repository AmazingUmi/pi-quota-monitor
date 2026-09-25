import { expect, it, vi } from "vitest";
import { antigravityWindowDuration, estimateQuotaAmount, FIVE_HOURS_MS, ONE_WEEK_MS, quotaAmountEstimates, type WindowReading } from "../src/quota-estimate.js";
import type { PeriodCostSummary, UsageAggregator } from "../src/tokens/aggregate.js";

const now = Date.parse("2026-09-23T12:00:00Z");
const resetAt = now + 2 * 3_600_000;
const cost = { totalTokens: 1000, estimatedCostUsd: 8, pricedRecords: 4, unpricedRecords: 0, unpricedTokens: 0 };
const sample = (capturedAt: number, remainingPercent: number, reset = resetAt): WindowReading => ({ capturedAt, window: { label: "5h", remainingPercent, resetAt: reset } });

it("uses only observed percentage-point changes and costs within the recorded timestamps", () => {
  const from = now - 3600_000;
  const end = now - 60_000;
  const costForPeriod = vi.fn(() => cost);
  const result = estimateQuotaAmount([sample(from, 70), sample(end, 60)], FIVE_HOURS_MS, costForPeriod, now, false, false,
    () => 10);
  expect(costForPeriod).toHaveBeenCalledExactlyOnceWith(from, end);
  expect(result).toMatchObject({ observedCostUsd: 8, observedTokens: 1000, usedPercent: 10, piAttributedPercent: 10,
    estimatedPeriodUsd: 80, estimatedRemainingUsd: 48, sampleStartAt: from, sampleEndAt: end });
  // The old algorithm would divide by all 40% consumed, including time before installation.
  expect(result.estimatedPeriodUsd).not.toBe(20);
});

it("estimates coincident Pi usage conditionally without calling account drops verified attribution", () => {
  const readings = [sample(now - 3600_000, 70), sample(now, 60)];
  const correlated = estimateQuotaAmount(readings, FIVE_HOURS_MS, () => cost, now);
  expect(correlated).toMatchObject({ usedPercent: 10, observedCostUsd: 8, attribution: "correlated",
    calibrationPercent: 10, estimatedPeriodUsd: 80 });
  expect(correlated.piAttributedPercent).toBeUndefined();
  expect(correlated.note).toContain("同区间仍可能有外部消耗");
  expect(estimateQuotaAmount(readings, FIVE_HOURS_MS, () => cost, now, false, false, () => 12).contaminated).toBe(true);
  const verified = estimateQuotaAmount(readings, FIVE_HOURS_MS, () => cost, now, false, false, () => 4);
  expect(verified).toMatchObject({ usedPercent: 10, attribution: "verified", piAttributedPercent: 4,
    calibrationPercent: 4, estimatedPeriodUsd: 200 });
});

it("excludes account-only declines rather than merging them into an earlier Pi sample", () => {
  const first = now - 120_000;
  const middle = now - 60_000;
  const readings = [sample(first, 90), sample(middle, 80), sample(now, 70)];
  const periodCost = vi.fn((start: number, end: number) => start === first && end === middle
    ? cost : { totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 });
  const result = estimateQuotaAmount(readings, FIVE_HOURS_MS, periodCost, now);
  expect(periodCost).toHaveBeenCalledWith(middle, now);
  expect(periodCost).toHaveBeenCalledWith(first, middle);
  expect(result).toMatchObject({ sampleStartAt: first, sampleEndAt: middle, observedCostUsd: 8,
    usedPercent: 10, excludedIntervals: 1, attribution: "correlated", estimatedPeriodUsd: 80,
    estimatedRemainingUsd: 56 });
  const accountOnly = estimateQuotaAmount(readings.slice(1), FIVE_HOURS_MS, periodCost, now);
  expect(accountOnly).toMatchObject({ contaminated: true, excludedIntervals: 1 });
  expect(accountOnly.estimatedPeriodUsd).toBeUndefined();
});

it("sums every eligible adjacent interval without charging external-only or unpriced gaps to Pi", () => {
  const times = [0, 1, 2, 3, 4, 5].map((i) => now - (5 - i) * 60_000);
  const readings = [90, 80, 70, 60, 55, 50].map((remaining, i) => sample(times[i], remaining));
  const empty = { totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };
  const summaries = [
    cost, empty,
    { ...cost, totalTokens: 500, estimatedCostUsd: 4 },
    { ...cost, totalTokens: 300, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1 },
    { ...cost, totalTokens: 250, estimatedCostUsd: 2 },
  ];
  const periodCost = vi.fn((start: number, end: number) => {
    const index = times.indexOf(start);
    expect(end).toBe(times[index + 1]);
    return summaries[index];
  });
  const result = estimateQuotaAmount(readings, FIVE_HOURS_MS, periodCost, now);
  expect(periodCost).toHaveBeenCalledTimes(5);
  expect(result).toMatchObject({ sampleIntervals: 3, sampleStartAt: times[0], sampleEndAt: times[5],
    observedCostUsd: 14, observedTokens: 1750, usedPercent: 25, calibrationPercent: 25,
    excludedIntervals: 1, unpricedRecords: 1, attribution: "correlated",
    estimatedPeriodUsd: 56, estimatedRemainingUsd: 28 });
  expect(result.note).toContain("累计 3 个");
  expect(result.note).toContain("排除 1 个");
  const verified = estimateQuotaAmount(readings, FIVE_HOURS_MS, periodCost, now, false, false,
    (_start, _end, accountDrop) => accountDrop / 2);
  expect(verified).toMatchObject({ sampleIntervals: 3, attribution: "verified", piAttributedPercent: 12.5,
    calibrationPercent: 12.5, estimatedPeriodUsd: 112 });
  const partial = estimateQuotaAmount(readings, FIVE_HOURS_MS, periodCost, now, false, false,
    (start, _end, accountDrop) => start === times[0] ? accountDrop / 2 : undefined);
  expect(partial.attribution).toBe("correlated");
  expect(partial.piAttributedPercent).toBeUndefined();
});

it("pairs slow weekly quota drops with preceding flat readings without pulling in later unfinished usage", () => {
  const times = [0, 1, 2, 3].map((i) => now - (3 - i) * 60_000);
  const readings = [80, 80, 79, 79].map((remaining, i) => sample(times[i], remaining));
  const empty = { totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };
  const costs = [{ ...cost, estimatedCostUsd: 4 }, empty, { ...cost, estimatedCostUsd: 6 }];
  const periodCost = vi.fn((start: number) => costs[times.indexOf(start)]);
  const weekly = estimateQuotaAmount(readings, ONE_WEEK_MS, periodCost, now);
  expect(weekly).toMatchObject({ sampleStartAt: times[0], sampleEndAt: times[2], sampleIntervals: 2,
    quotaChanges: 1, observedCostUsd: 4, observedTokens: 1000, usedPercent: 1,
    pendingTokens: 1000, estimatedPeriodUsd: 400, estimatedRemainingUsd: 316 });
  expect(weekly.note).toContain("等待周额度变化");
  expect(periodCost).toHaveBeenCalledTimes(3);
  const attributed = vi.fn(() => 0.5);
  const verified = estimateQuotaAmount(readings, ONE_WEEK_MS, periodCost, now, false, false, attributed);
  expect(attributed).toHaveBeenCalledExactlyOnceWith(times[0], times[2], 1);
  expect(verified).toMatchObject({ attribution: "verified", piAttributedPercent: 0.5, estimatedPeriodUsd: 800 });
  const fiveHour = estimateQuotaAmount(readings, FIVE_HOURS_MS, periodCost, now);
  expect(fiveHour.estimatedPeriodUsd).toBeUndefined();
  const plateau = estimateQuotaAmount(readings.slice(0, 2), ONE_WEEK_MS, periodCost, now);
  expect(plateau.estimatedPeriodUsd).toBeUndefined();
  expect(plateau.note).toContain("周额度尚未下降");
});

it("accumulates completed weekly declines while excluding account-only and unpriced blocks", () => {
  const times = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => now - (7 - i) * 60_000);
  const readings = [90, 90, 89, 89, 88, 87, 87, 86].map((remaining, i) => sample(times[i], remaining));
  const empty = { totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };
  const costs = [{ ...cost, estimatedCostUsd: 4 }, empty,
    { ...cost, estimatedCostUsd: 6 }, { ...cost, estimatedCostUsd: 2 },
    empty, { ...cost, unpricedRecords: 1 }, empty];
  const result = estimateQuotaAmount(readings, ONE_WEEK_MS, (start) => costs[times.indexOf(start)], now);
  expect(result).toMatchObject({ sampleIntervals: 4, quotaChanges: 2, observedCostUsd: 12,
    observedTokens: 3000, usedPercent: 2, excludedIntervals: 1, unpricedRecords: 1,
    estimatedPeriodUsd: 600, estimatedRemainingUsd: 516 });
  // The unpriced plateau and its subsequent drop form ONE rejected block.
  expect(result.sampleEndAt).toBe(times[4]);
  const reset = estimateQuotaAmount([sample(times[0], 80, resetAt - ONE_WEEK_MS),
    sample(times[1], 80, resetAt - ONE_WEEK_MS), sample(times[2], 100), sample(times[3], 99)],
  ONE_WEEK_MS, () => cost, now, false, true);
  expect(reset).toMatchObject({ sampleStartAt: times[2], sampleIntervals: 1, observedCostUsd: 8 });
});

it("retains recent eligible samples when older cost history has expired", () => {
  const first = now - 120_000;
  const middle = now - 60_000;
  const result = estimateQuotaAmount([sample(first, 90), sample(middle, 80), sample(now, 70)], FIVE_HOURS_MS,
    (start) => start === first ? { ...cost, incompleteWindow: true } : cost, now);
  expect(result).toMatchObject({ sampleIntervals: 1, sampleStartAt: middle,
    observedCostUsd: 8, usedPercent: 10, estimatedPeriodUsd: 80 });
  expect(result.note).toContain("更早的区间超出账本缓存");
});

it("does not classify unpriced local activity as external-only", () => {
  const result = estimateQuotaAmount([sample(now - 60_000, 70), sample(now, 60)], FIVE_HOURS_MS,
    () => ({ ...cost, totalTokens: 1000, pricedRecords: 0, unpricedRecords: 1, estimatedCostUsd: 0 }), now);
  expect(result.note).toContain("未计价");
  expect(result.contaminated).toBeUndefined();
});

it("recognizes supported Antigravity windows without inventing other periods", () => {
  expect(antigravityWindowDuration("Five Hour Limit Remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("5-hour limit remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("Weekly Limit Remaining")).toBe(ONE_WEEK_MS);
  expect(antigravityWindowDuration("Daily requests")).toBeUndefined();
});

it("does not extrapolate from one reading, zero change, expired/missing windows or incomplete costs", () => {
  const readings = [sample(now - 3600_000, 70), sample(now, 60)];
  const estimate = (rows = readings, summary: PeriodCostSummary = cost, stale = false) => estimateQuotaAmount(rows, FIVE_HOURS_MS, () => summary, now, stale);
  expect(estimate([]).estimatedPeriodUsd).toBeUndefined();
  expect(estimate([readings[1]]).note).toContain("第二次");
  expect(estimate([sample(now - 3600_000, 60), readings[1]]).note).toContain("尚未下降");
  expect(estimate([{ capturedAt: now, window: { label: "5h", remainingPercent: 60 } }]).note).toContain("重置时间");
  expect(estimate([sample(now, 60, now)]).note).toContain("已到重置时间");
  expect(estimate(readings, { ...cost, estimatedCostUsd: 0 }).estimatedPeriodUsd).toBeUndefined();
  expect(estimate(readings, { ...cost, unpricedRecords: 1 }).note).toContain("未计价");
  expect(estimate(readings, { ...cost, incompleteWindow: true }).note).toContain("缓存范围");
  expect(estimate(readings, cost, true).note).toContain("已过期");
});

it("never crosses a reset or quota increase and accepts small reset timestamp rounding", () => {
  const estimate = (readings: WindowReading[]) => estimateQuotaAmount(readings, FIVE_HOURS_MS, () => cost, now);
  expect(estimate([sample(now - 3600_000, 70, resetAt - FIVE_HOURS_MS), sample(now, 60)]).estimatedPeriodUsd).toBeUndefined();
  expect(estimate([sample(now - 3600_000, 50), sample(now, 60)]).estimatedPeriodUsd).toBeUndefined();
  const result = estimate([sample(now - 7200_000, 40), sample(now - 3600_000, 70), sample(now, 60, resetAt + 1000)]);
  expect(result.sampleStartAt).toBe(now - 3600_000);
  expect(result).toMatchObject({ attribution: "correlated", sampleStartAt: now - 3600_000, estimatedRemainingUsd: 48 });
  const afterReset = estimate([sample(now - 180_000, 80, resetAt - FIVE_HOURS_MS),
    sample(now - 120_000, 70, resetAt - FIVE_HOURS_MS), sample(now - 60_000, 90), sample(now, 80)]);
  expect(afterReset).toMatchObject({ sampleIntervals: 1, sampleStartAt: now - 60_000, observedCostUsd: 8 });
});

it("recalibrates after an early manual increase without crossing into the old OAI period", () => {
  const before = sample(now - 180_000, 30);
  const reset = sample(now - 120_000, 95);
  const after = sample(now - 60_000, 85);
  const periodCost = vi.fn(() => cost);
  const result = estimateQuotaAmount([before, reset, after], ONE_WEEK_MS, periodCost, now, false, true, () => 10);
  expect(periodCost).toHaveBeenCalledExactlyOnceWith(reset.capturedAt, after.capturedAt);
  expect(result).toMatchObject({ sampleStartAt: reset.capturedAt, attribution: "verified", estimatedPeriodUsd: 80 });
});

it("estimates within an unusually long OAI period without assuming exactly 7 days", () => {
  const earlier = sample(now - 7 * 86_400_000, 70, now + 3_600_000);
  const later = sample(now, 60, now + 3_600_000);
  const estimate = estimateQuotaAmount([earlier, later], FIVE_HOURS_MS, () => cost, now, false, true, () => 10);
  expect(estimate).toMatchObject({ sampleStartAt: earlier.capturedAt, estimatedPeriodUsd: 80, estimatedRemainingUsd: 48 });
});

it("applies plateau matching to the Codex weekly window without changing the 5h calculation", () => {
  const time = Date.now();
  const times = [time - 120_000, time - 60_000, time];
  const reading = (capturedAt: number, weekly: number, fiveHour: number) => ({ capturedAt, plan: "pro",
    weekly: { label: "weekly", remainingPercent: weekly, resetAt: time + 86_400_000, windowMinutes: 10080 },
    fiveHour: { label: "5h", remainingPercent: fiveHour, resetAt: time + 2 * 3_600_000, windowMinutes: 300 },
  });
  const earlier = reading(times[0], 80, 50);
  const middle = reading(times[1], 80, 50);
  const latest = reading(times[2], 79, 49);
  const aggregator = { state: () => ({ stale: false }), estimateCostForPeriod: (_provider: string, start: number) =>
    start === times[0] ? cost : { ...cost, totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0 } } as unknown as UsageAggregator;
  const estimates = quotaAmountEstimates(aggregator, { value: latest }, {}, [earlier, middle], []);
  expect(estimates.codex.weekly).toMatchObject({ sampleIntervals: 2, quotaChanges: 1,
    observedCostUsd: 8, estimatedPeriodUsd: 800 });
  expect(estimates.codex.fiveHour.estimatedPeriodUsd).toBeUndefined();
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
