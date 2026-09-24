import type { DashboardState } from "../../src/dashboard.js";

/** Synthetic data only; also useful for local visual checks without a Pi login. */
export function dashboardFixture() {
  const now = Date.now();
  const currentHour = Math.floor(now / 3600000) * 3600000;
  const date = new Date(now);
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const estimate = { observedCostUsd: 12.6, observedTokens: 500000, sampleStartAt: now - 3600000, sampleEndAt: now, usedPercent: 27, estimatedPeriodUsd: 46.67, estimatedRemainingUsd: 34.07, note: "按读数时间区间内记录的 Token、金额和额度下降量估算。" };
  const models = [
    { provider: "openai-codex", model: "gpt-6-sol", input: 920000, output: 180000, reasoning: 65000, cacheRead: 410000, cacheWrite: 0, totalTokens: 1510000, estimatedCostUsd: 5.54, pricedRecords: 80, unpricedRecords: 0, unpricedTokens: 0 },
    { provider: "antigravity", model: "gemini-3.1-pro", input: 510000, output: 120000, reasoning: 43000, cacheRead: 200000, cacheWrite: 0, totalTokens: 830000, estimatedCostUsd: 3.46, pricedRecords: 30, unpricedRecords: 0, unpricedTokens: 0 },
    { provider: "antigravity", model: "claude-sonnet-4-6", input: 82000, output: 18000, reasoning: 0, cacheRead: 40000, cacheWrite: 0, totalTokens: 140000, estimatedCostUsd: 3.6, pricedRecords: 18, unpricedRecords: 0, unpricedTokens: 0 },
  ];
  const timeline = Array.from({ length: 24 }, (_, index) => ({
    bucket: String(currentHour - (23 - index) * 3600000), provider: "openai-codex", model: "gpt-6-sol",
    totalTokens: [0, 0, 0, 10000, 24000, 16000, 0, 5000, 120000, 95000, 185000, 54000][index % 12],
    estimatedCostUsd: [0, 0, 0, .05, .12, .08, 0, .03, .64, .48, .95, .28][index % 12],
    pricedRecords: 2, unpricedRecords: 0,
  }));
  const state: DashboardState = {
    accounts: [{ id: "all", name: "总体用量" }, { id: "account:pro", name: "工作账号" }, { id: "account:plus", name: "个人账号" }],
    profiles: [{ name: "work-pro", accountId: "pro" }, { name: "personal-plus", accountId: "plus" }],
    currentProfile: "work-pro", currentAccountId: "account:pro", selectedAccountId: "account:pro", backups: ["/private/demo-backup.json"],
    codex: { value: { capturedAt: now, plan: "plus", fiveHour: { label: "5h", remainingPercent: 73, resetAt: now + 4800000 }, weekly: { label: "weekly", remainingPercent: 61, resetAt: now + 172800000 } } },
    antigravity: { value: { capturedAt: now, plan: "AI Pro", models: [], groups: [
      { name: "Gemini", windows: [{ label: "5 小时窗口", remainingPercent: 95, resetAt: now + 7200000 }, { label: "每周窗口", remainingPercent: 83, resetAt: now + 345600000 }] },
      { name: "Claude / GPT", windows: [{ label: "5 小时窗口", remainingPercent: 20, resetAt: now + 3600000 }, { label: "每周窗口", remainingPercent: 8, resetAt: now + 86400000 }] },
    ] } },
    usage: {
      totals: { input: 1512000, output: 318000, reasoning: 108000, cacheRead: 650000, cacheWrite: 0, totalTokens: 2480000 },
      models, timeline: { hours: timeline, days: [{ ...timeline[10], bucket: today }], today, currentHour },
      pricing: { asOf: "2026-09-23", estimatedCostUsd: 12.6, pricedRecords: 128, unpricedRecords: 0, unpricedTokens: 0 },
      records: 128, invalidRecords: 0, updatedAt: now, stale: false,
    },
    context: { tokens: 70720, contextWindow: 272000, percent: 26 },
    quotaEstimates: { codex: { fiveHour: estimate, weekly: estimate }, antigravity: { groups: [{ name: "Gemini", windows: [estimate, estimate] }, { name: "Claude / GPT", windows: [estimate, estimate] }] } },
    config: { dashboardPort: 38457, refreshIntervalSeconds: 180, staleAfterSeconds: 60, requestTimeoutSeconds: 10, showReset: true, showOaiInStatusbar: true, showAgyInStatusbar: true },
    updatedAt: now,
  };
  return { ...state, control: "test-control", usage: { ...state.usage, pricing: { ...state.usage.pricing, catalog: [
    { provider: "openai-codex", model: "gpt-6-sol", rates: { input: 2, output: 10, cacheRead: .2 }, source: "https://openai.com/api/pricing/" },
  ] } } };
}
