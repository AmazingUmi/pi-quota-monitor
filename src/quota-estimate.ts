import type { AntigravityQuota, CodexQuota, ProviderCache, QuotaAmountEstimate, QuotaAmountEstimates, QuotaWindow } from "./types.js";
import type { PeriodCostSummary, UsageAggregator } from "./tokens/aggregate.js";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export interface WindowReading { capturedAt: number; window?: QuotaWindow }

export function antigravityWindowDuration(label: string): number | undefined {
  if (/(?:\b5\s*[- ]?(?:h|hours?)\b|\bfive\s*[- ]?hours?\b)/i.test(label)) return FIVE_HOURS_MS;
  if (/\bweek/i.test(label)) return ONE_WEEK_MS;
  return undefined;
}

/** Calibrate only against observed quota deltas and ledger records in that exact observation interval. */
export function estimateQuotaAmount(
  readings: WindowReading[],
  durationMs: number | undefined,
  costForPeriod: (startAt: number, endAt: number) => PeriodCostSummary,
  now = Date.now(),
  ledgerStale = false,
): QuotaAmountEstimate {
  const sorted = [...new Map(readings.filter((r) => Number.isFinite(r.capturedAt) && r.capturedAt <= now)
    .map((r) => [r.capturedAt, r])).values()].sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = sorted.at(-1);
  const window = latest?.window;
  if (!window || !Number.isFinite(window.remainingPercent)) return { note: "此额度窗口暂无数据，无法估算金额。" };
  if (durationMs === undefined || durationMs <= 0) return { note: "仅对可识别的 5 小时 / 每周窗口估算金额。" };
  if (window.resetAt === undefined || !Number.isFinite(window.resetAt)) return { note: "缺少本周期重置时间，无法匹配读数。" };
  if (window.resetAt <= now) return { note: "额度窗口已到重置时间，请刷新额度后查看估算。" };
  let baseline = latest!;
  // Do not cross a reset, missing observation, quota increase, or duplicated timestamp.
  for (let i = sorted.length - 2; i >= 0; i--) {
    const prior = sorted[i];
    const w = prior.window;
    if (!w || !Number.isFinite(w.remainingPercent) || w.resetAt === undefined
      || Math.abs(w.resetAt - window.resetAt) > 60_000 || prior.capturedAt < window.resetAt - durationMs
      || prior.capturedAt >= baseline.capturedAt || w.resetAt <= baseline.capturedAt
      || w.remainingPercent < baseline.window!.remainingPercent) break;
    baseline = prior;
  }
  if (baseline === latest) return { note: "等待同一周期的第二次额度读数，暂不使用全部已用额度外推。" };
  const usedPercent = baseline.window!.remainingPercent - window.remainingPercent;
  const cost = costForPeriod(baseline.capturedAt, latest!.capturedAt);
  const observed = { observedCostUsd: cost.estimatedCostUsd, observedTokens: cost.totalTokens,
    sampleStartAt: baseline.capturedAt, sampleEndAt: latest!.capturedAt, usedPercent,
    ...(cost.unpricedRecords ? { unpricedRecords: cost.unpricedRecords } : {}), ...(ledgerStale ? { ledgerStale: true } : {}) };
  if (!cost.pricedRecords || cost.estimatedCostUsd <= 0) return { ...observed, note: "两次读数之间没有正金额的可计价记录，无法外推金额。" };
  if (usedPercent <= 0) return { ...observed, note: "记录区间内额度尚未下降，等待新的读数后估算。" };
  if (ledgerStale || cost.unpricedRecords) return { ...observed, note: ledgerStale ? "账本汇总已过期，暂不外推金额。" : "记录区间含未计价用量，暂不外推金额。" };
  const estimatedPeriodUsd = cost.estimatedCostUsd / (usedPercent / 100);
  if (!Number.isFinite(estimatedPeriodUsd)) return { ...observed, note: "额度变化过小，暂不外推金额。" };
  return { ...observed, estimatedPeriodUsd, estimatedRemainingUsd: estimatedPeriodUsd * window.remainingPercent / 100,
    note: "按读数时间区间内已记录的 Token、金额和额度下降量估算；其他客户端的消耗会造成偏差。" };
}

export function quotaAmountEstimates(
  aggregator: UsageAggregator,
  codex: ProviderCache<CodexQuota>, antigravity: ProviderCache<AntigravityQuota>,
  codexHistory: CodexQuota[], agyHistory: AntigravityQuota[],
): QuotaAmountEstimates {
  const now = Date.now();
  const stale = aggregator.state().stale;
  const codexSamples = codex.value ? [...codexHistory.filter((q) => q.capturedAt < codex.value!.capturedAt), codex.value] : [];
  const agySamples = antigravity.value ? [...agyHistory.filter((q) => q.capturedAt < antigravity.value!.capturedAt), antigravity.value] : [];
  const codexEstimate = (key: "fiveHour" | "weekly", duration: number) => estimateQuotaAmount(
    codexSamples.map((q) => ({ capturedAt: q.capturedAt, window: q.plan === codex.value?.plan ? q[key] : undefined })), duration,
    (start, end) => aggregator.estimateCostForPeriod("openai-codex", start, end), now, stale);
  return {
    codex: { fiveHour: codexEstimate("fiveHour", (codex.value?.fiveHour?.windowMinutes ?? 300) * 60_000),
      weekly: codexEstimate("weekly", (codex.value?.weekly?.windowMinutes ?? 10080) * 60_000) },
    antigravity: { groups: (antigravity.value?.groups ?? []).map((group) => ({ name: group.name,
      windows: group.windows.map((window) => {
        const duration = window.windowMinutes ? window.windowMinutes * 60_000 : antigravityWindowDuration(window.label);
        const modelFilter = /gemini/i.test(group.name) ? (model: string) => /^gemini-/i.test(model)
          : /claude|gpt/i.test(group.name) ? (model: string) => /^(claude-|gpt-)/i.test(model) : undefined;
        if (!duration || ![FIVE_HOURS_MS, ONE_WEEK_MS].includes(duration) || !modelFilter) return null; // Never attribute another model pool's spend to this pool.
        return estimateQuotaAmount(agySamples.map((q) => ({ capturedAt: q.capturedAt,
          window: q.plan === antigravity.value?.plan ? q.groups.find((g) => g.name === group.name)?.windows.find((w) =>
            (w.windowMinutes ? w.windowMinutes * 60_000 : antigravityWindowDuration(w.label)) === duration) : undefined,
        })), duration, (start, end) => aggregator.estimateCostForPeriod("antigravity", start, end, modelFilter), now, stale);
      }),
    })) },
  };
}
