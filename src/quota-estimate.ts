import type { QuotaAmountEstimate, QuotaWindow } from "./types.js";
import type { PeriodCostSummary } from "./tokens/aggregate.js";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function antigravityWindowDuration(label: string): number | undefined {
  if (/(?:\b5\s*[- ]?(?:h|hours?)\b|\bfive\s*[- ]?hours?\b)/i.test(label)) return FIVE_HOURS_MS;
  if (/\bweek/i.test(label)) return ONE_WEEK_MS;
  return undefined;
}

export function estimateQuotaAmount(
  window: QuotaWindow | undefined,
  durationMs: number | undefined,
  costForPeriod: (startAt: number, endAt: number) => PeriodCostSummary,
  now = Date.now(),
  ledgerStale = false,
): QuotaAmountEstimate {
  if (!window) return { note: "此额度窗口暂无数据，无法估算金额。" };
  if (durationMs === undefined) return { note: "仅对可识别的 5 小时 / 每周窗口估算金额。" };
  if (window.resetAt === undefined || !Number.isFinite(window.resetAt)) {
    return { note: "缺少本周期重置时间，无法估算金额。" };
  }
  if (window.resetAt <= now) return { note: "额度窗口已到重置时间，请刷新额度后查看估算。" };

  const remainingPercent = Math.max(0, Math.min(100, window.remainingPercent));
  const usedPercent = 100 - remainingPercent;
  const periodCost = costForPeriod(window.resetAt - durationMs, Math.min(now, window.resetAt));
  if (!periodCost.pricedRecords) {
    const unpriced = periodCost.unpricedRecords ? `；另有 ${periodCost.unpricedRecords} 条记录未计价` : "";
    return { note: `本周期没有可计价的账本用量，无法外推金额${unpriced}。`,
      ...(periodCost.unpricedRecords ? { unpricedRecords: periodCost.unpricedRecords } : {}), ...(ledgerStale ? { ledgerStale: true } : {}) };
  }
  if (usedPercent <= 0) {
    return { note: "Provider 尚未报告本周期额度消耗比例，无法由金额外推。",
      observedCostUsd: periodCost.estimatedCostUsd, usedPercent,
      ...(periodCost.unpricedRecords ? { unpricedRecords: periodCost.unpricedRecords } : {}), ...(ledgerStale ? { ledgerStale: true } : {}) };
  }

  const estimatedPeriodUsd = periodCost.estimatedCostUsd / (usedPercent / 100);
  const estimatedRemainingUsd = estimatedPeriodUsd * (remainingPercent / 100);
  const notes = ["仅按本插件本周期可计价用量估算"];
  if (periodCost.unpricedRecords) notes.push(`${periodCost.unpricedRecords} 条记录未计价，金额可能偏低`);
  if (ledgerStale) notes.push("账本汇总已过期");
  return {
    note: notes.join("；"),
    observedCostUsd: periodCost.estimatedCostUsd,
    usedPercent,
    estimatedPeriodUsd,
    estimatedRemainingUsd,
    ...(periodCost.unpricedRecords ? { unpricedRecords: periodCost.unpricedRecords } : {}),
    ...(ledgerStale ? { ledgerStale: true } : {}),
  };
}
