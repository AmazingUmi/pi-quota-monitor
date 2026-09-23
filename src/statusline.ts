import type { AntigravityQuota, CodexQuota, ProviderCache, QuotaWindow, TokenTotals } from "./types.js";

export function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function countdown(resetAt: number | undefined, now = Date.now()): string | undefined {
  if (resetAt === undefined) return undefined;
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

export function groupWindow(usage: AntigravityQuota | undefined, kind: "gemini" | "shared"): QuotaWindow | undefined {
  if (!usage) return undefined;
  const pattern = kind === "gemini" ? /gemini/i : /claude|gpt|shared/i;
  const groups = usage.groups.filter((group) => pattern.test(group.name));
  const windows = groups.flatMap((group) => group.windows);
  if (windows.length) return windows.reduce((lowest, window) => window.remainingPercent < lowest.remainingPercent ? window : lowest);
  const models = usage.models.filter((model) => pattern.test(`${model.modelId} ${model.displayName ?? ""}`) && model.remainingPercent !== undefined);
  if (!models.length) return undefined;
  const lowest = models.reduce((a, b) => (a.remainingPercent ?? 101) < (b.remainingPercent ?? 101) ? a : b);
  return { label: lowest.modelId, remainingPercent: lowest.remainingPercent!, resetAt: lowest.resetAt };
}

function percentage(value: number | undefined): string {
  return value === undefined ? "?" : `${Math.round(value)}%`;
}

export function formatStatus(
  codex: ProviderCache<CodexQuota>,
  antigravity: ProviderCache<AntigravityQuota>,
  totals: TokenTotals,
  showReset: boolean,
  now = Date.now(),
): string {
  const gemini = groupWindow(antigravity.value, "gemini");
  const shared = groupWindow(antigravity.value, "shared");
  const codexReset = showReset ? countdown(codex.value?.fiveHour?.resetAt, now) : undefined;
  return [
    `OAI ${percentage(codex.value?.fiveHour?.remainingPercent)}/${percentage(codex.value?.weekly?.remainingPercent)}${codexReset ? ` ↻${codexReset}` : ""}`,
    `AGY G${percentage(gemini?.remainingPercent)} C${percentage(shared?.remainingPercent)}`,
    `↑${compactTokens(totals.input)} ↓${compactTokens(totals.output)}`,
  ].join(" | ");
}

function formatWindow(window: QuotaWindow | undefined): string {
  if (!window) return "unavailable";
  return `${percentage(window.remainingPercent)} remaining${window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleString()} (${countdown(window.resetAt)})` : ""}`;
}

export function formatDetails(
  codex: ProviderCache<CodexQuota>,
  antigravity: ProviderCache<AntigravityQuota>,
  session: TokenTotals,
  daily: TokenTotals,
  interval: number,
): string {
  const codexResult = codex.value;
  const agy = antigravity.value;
  const lines = [
    `Quota monitor · refresh every ${interval}s`,
    `Codex${codexResult?.plan ? ` (${codexResult.plan})` : ""}: 5h ${formatWindow(codexResult?.fiveHour)}; weekly ${formatWindow(codexResult?.weekly)}`,
    `Antigravity${agy?.plan ? ` (${agy.plan})` : ""}: Gemini ${formatWindow(groupWindow(agy, "gemini"))}; Claude/GPT ${formatWindow(groupWindow(agy, "shared"))}`,
    `Session: input ${session.input}, output ${session.output}, reasoning ${session.reasoning}, cacheRead ${session.cacheRead}, cacheWrite ${session.cacheWrite}, total ${session.totalTokens}`,
    `Today: input ${daily.input}, output ${daily.output}, reasoning ${daily.reasoning}, cacheRead ${daily.cacheRead}, cacheWrite ${daily.cacheWrite}, total ${daily.totalTokens}`,
  ];
  if (codexResult) lines.push(`Codex updated ${new Date(codexResult.capturedAt).toLocaleString()}`);
  if (agy) lines.push(`Antigravity updated ${new Date(agy.capturedAt).toLocaleString()}`);
  if (codex.error) lines.push(`Codex: ${codex.error} (showing last successful result)`);
  if (antigravity.error) lines.push(`Antigravity: ${antigravity.error} (showing last successful result)`);
  if (agy?.summaryError) lines.push(agy.summaryError);
  return lines.join("\n");
}
