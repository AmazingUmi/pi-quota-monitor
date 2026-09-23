import { expect, it, vi } from "vitest";
import { antigravityWindowDuration, estimateQuotaAmount, FIVE_HOURS_MS, ONE_WEEK_MS } from "../src/quota-estimate.js";

const emptyCost = { estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };

it("infers period and remaining amounts from priced period usage and provider usage percentage", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const resetAt = now + 2 * 60 * 60 * 1000;
  const costForPeriod = vi.fn(() => ({ estimatedCostUsd: 8, pricedRecords: 4, unpricedRecords: 1, unpricedTokens: 100 }));
  const result = estimateQuotaAmount({ label: "5h", remainingPercent: 60, resetAt }, FIVE_HOURS_MS, costForPeriod, now, true);
  expect(costForPeriod).toHaveBeenCalledWith(resetAt - FIVE_HOURS_MS, now);
  expect(result).toMatchObject({
    observedCostUsd: 8, usedPercent: 40, estimatedPeriodUsd: 20, estimatedRemainingUsd: 12,
    unpricedRecords: 1, ledgerStale: true,
  });
  expect(result.note).toContain("金额可能偏低");
  expect(result.note).toContain("账本汇总已过期");
});

it("recognizes Antigravity 5-hour and weekly buckets but does not invent other periods", () => {
  expect(antigravityWindowDuration("Five Hour Limit Remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("5-hour limit remaining")).toBe(FIVE_HOURS_MS);
  expect(antigravityWindowDuration("Weekly Limit Remaining")).toBe(ONE_WEEK_MS);
  expect(antigravityWindowDuration("Daily requests")).toBeUndefined();
});

it("does not estimate a missing window, missing reset, expired period, or unobserved cost", () => {
  const now = 100_000;
  expect(estimateQuotaAmount(undefined, FIVE_HOURS_MS, () => emptyCost, now).estimatedPeriodUsd).toBeUndefined();
  expect(estimateQuotaAmount({ label: "5h", remainingPercent: 50 }, FIVE_HOURS_MS, () => emptyCost, now).note)
    .toContain("缺少本周期重置时间");
  expect(estimateQuotaAmount({ label: "5h", remainingPercent: 50, resetAt: now }, FIVE_HOURS_MS, () => emptyCost, now).note)
    .toContain("已到重置时间");
  expect(estimateQuotaAmount({ label: "5h", remainingPercent: 100, resetAt: now + 10_000 }, FIVE_HOURS_MS, () => emptyCost, now).note)
    .toContain("没有可计价的账本用量");
  expect(estimateQuotaAmount({ label: "5h", remainingPercent: 100, resetAt: now + 10_000 }, FIVE_HOURS_MS,
    () => ({ estimatedCostUsd: 0, pricedRecords: 1, unpricedRecords: 0, unpricedTokens: 0 }), now).note)
    .toContain("尚未报告");
});
