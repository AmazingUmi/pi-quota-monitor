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

/** Compare adjacent readings, never treating an account-wide drop as verified Pi consumption. */
export function estimateQuotaAmount(
  readings: WindowReading[],
  durationMs: number | undefined,
  costForPeriod: (startAt: number, endAt: number) => PeriodCostSummary,
  now = Date.now(),
  ledgerStale = false,
  observedPeriod = false,
  attributedQuota?: (startAt: number, endAt: number, accountDrop: number) => number | undefined,
): QuotaAmountEstimate {
  const sorted = [...new Map(readings.filter((r) => Number.isFinite(r.capturedAt) && r.capturedAt <= now)
    .map((r) => [r.capturedAt, r])).values()].sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = sorted.at(-1);
  const window = latest?.window;
  if (!window || !Number.isFinite(window.remainingPercent)) return { note: "此额度窗口暂无数据，无法估算金额。" };
  if (durationMs === undefined || durationMs <= 0) return { note: "仅对可识别的 5 小时 / 每周窗口估算金额。" };
  if (window.resetAt === undefined || !Number.isFinite(window.resetAt)) return { note: "缺少本周期重置时间，无法匹配读数。" };
  if (window.resetAt <= now) return { note: "额度窗口已到重置时间，请刷新额度后查看估算。" };
  let recent: Omit<QuotaAmountEstimate, "note"> | undefined;
  let excludedIntervals = 0;
  // Use only adjacent observations. Spanning multiple readings would quietly fold an
  // account-only (e.g. Codex CLI) drop into Pi's calibration denominator.
  for (let i = sorted.length - 1; i > 0; i--) {
    const end = sorted[i];
    const start = sorted[i - 1];
    const current = end.window;
    const prior = start.window;
    if (!current || !prior || !Number.isFinite(current.remainingPercent) || !Number.isFinite(prior.remainingPercent)
      || current.resetAt === undefined || prior.resetAt === undefined
      || Math.abs(current.resetAt - window.resetAt) > 60_000
      || Math.abs(prior.resetAt - current.resetAt) > 60_000
      || (!observedPeriod && start.capturedAt < window.resetAt - durationMs)
      || start.capturedAt >= end.capturedAt || prior.resetAt <= end.capturedAt
      || prior.remainingPercent < current.remainingPercent) break;
    const usedPercent = prior.remainingPercent - current.remainingPercent;
    const cost = costForPeriod(start.capturedAt, end.capturedAt);
    const observed = { observedCostUsd: cost.estimatedCostUsd, observedTokens: cost.totalTokens,
      sampleStartAt: start.capturedAt, sampleEndAt: end.capturedAt, usedPercent,
      ...(cost.unpricedRecords ? { unpricedRecords: cost.unpricedRecords } : {}),
      ...(ledgerStale ? { ledgerStale: true } : {}) };
    recent ??= observed;
    if (ledgerStale) return { ...observed, note: "账本汇总已过期，暂不外推金额。" };
    if (cost.incompleteWindow) return { ...observed, note: "采样区间早于账本金额缓存范围，无法核实完整 Pi 用量。" };
    if (cost.unpricedRecords) return { ...observed, note: "记录区间含未计价用量，暂不外推金额。" };
    if (usedPercent <= 0) continue;
    if (cost.totalTokens <= 0) {
      excludedIntervals++;
      continue;
    }
    if (!cost.pricedRecords || cost.estimatedCostUsd <= 0) continue;
    const independentlyAttributed = attributedQuota?.(start.capturedAt, end.capturedAt, usedPercent);
    if (independentlyAttributed !== undefined && (!Number.isFinite(independentlyAttributed)
      || independentlyAttributed <= 0 || independentlyAttributed > usedPercent)) {
      return { ...observed, contaminated: true, note: "Pi 归因额度数据无效，此区间不用于金额校准。" };
    }
    const calibrationPercent = independentlyAttributed ?? usedPercent;
    const estimatedPeriodUsd = cost.estimatedCostUsd / (calibrationPercent / 100);
    if (!Number.isFinite(estimatedPeriodUsd)) continue;
    return { ...observed, calibrationPercent, ...(independentlyAttributed !== undefined ? { piAttributedPercent: independentlyAttributed } : {}),
      attribution: independentlyAttributed !== undefined ? "verified" : "correlated", excludedIntervals,
      estimatedPeriodUsd, estimatedRemainingUsd: estimatedPeriodUsd * window.remainingPercent / 100,
      note: independentlyAttributed !== undefined
        ? "按独立核实的 Pi 归因额度和本地 API 标价换算；非账户实际账单。"
        : `按同一采样区间的 Pi Token 金额与账号额度下降作条件估算${excludedIntervals ? `；已排除 ${excludedIntervals} 个无 Pi 记录的额度下降区间` : ""}。同区间仍可能有外部消耗，此值不是已核实的 Pi 归因金额。` };
  }
  if (!recent) return { note: "等待同一周期的第二次额度读数，暂不使用全部已用额度外推。" };
  if (excludedIntervals) return { ...recent, contaminated: true, excludedIntervals,
    note: "账号额度下降，但对应区间没有 Pi Token 记录；疑似外部客户端用量或本地漏记，不用于校准。" };
  if (!recent.usedPercent) return { ...recent, note: "记录区间内额度尚未下降，等待新的读数后估算。" };
  return { ...recent, note: "两次读数之间没有正金额的可计价 Pi 用量，无法外推金额。" };
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
    (start, end) => aggregator.estimateCostForPeriod("openai-codex", start, end), now, stale, true);
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
