import type { CodexQuota, QuotaWindow } from "../types.js";
import { clampPercent, cleanText, epochMilliseconds, fetchJsonObject, isRecord, numberValue } from "./http.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function parseWindow(value: unknown, label: string): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = numberValue(value.used_percent);
  if (used === undefined) return undefined;
  const seconds = numberValue(value.limit_window_seconds);
  const resetAt = epochMilliseconds(value.reset_at);
  return {
    label,
    remainingPercent: 100 - clampPercent(used),
    ...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export function parseCodexQuota(payload: unknown, capturedAt = Date.now()): CodexQuota {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) {
    throw new Error("Codex rate-limit data unavailable.");
  }
  const primary = parseWindow(payload.rate_limit.primary_window, "5h");
  const secondary = parseWindow(payload.rate_limit.secondary_window, "weekly");
  if (!primary && !secondary) throw new Error("Codex returned no quota windows.");
  const windows = [primary, secondary].filter((window): window is QuotaWindow => window !== undefined);
  const fiveHour = windows.find((window) => window.windowMinutes !== undefined && window.windowMinutes <= 360)
    ?? primary;
  const weekly = windows.find((window) => window !== fiveHour && window.windowMinutes !== undefined && window.windowMinutes >= 7 * 24 * 60)
    ?? windows.find((window) => window !== fiveHour);
  return {
    capturedAt,
    ...(cleanText(payload.plan_type) ? { plan: cleanText(payload.plan_type) } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

export async function queryCodexQuota(
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CodexQuota> {
  if (auth.baseUrl && new URL(auth.baseUrl).origin !== new URL(USAGE_URL).origin) {
    throw new Error("Codex credential belongs to a custom endpoint.");
  }
  const headers = new Headers();
  // Only send the bearer credential: unrelated provider-supplied headers might carry other secrets.
  const authorization = Object.entries(auth.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  if (typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization)) {
    headers.set("Authorization", authorization);
  } else if (auth.apiKey) {
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
  }
  if (!headers.has("Authorization")) throw new Error("Codex OAuth credentials unavailable.");
  const payload = await fetchJsonObject(USAGE_URL, { headers }, { signal, timeoutMs });
  return parseCodexQuota(payload);
}
