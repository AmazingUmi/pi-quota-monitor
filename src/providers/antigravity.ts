import type { AntigravityModelQuota, AntigravityQuota, AntigravityQuotaGroup, QuotaWindow } from "../types.js";
import { clampPercent, cleanText, epochMilliseconds, fetchJsonObject, isRecord, numberValue, QuotaQueryError } from "./http.js";

// Public Antigravity provider endpoints. Never forward OAuth credentials to a configurable URL.
const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const METADATA = { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } };

function parseWindows(payload: unknown): AntigravityQuotaGroup[] {
  if (!isRecord(payload) || !Array.isArray(payload.groups)) return [];
  return payload.groups.flatMap((raw): AntigravityQuotaGroup[] => {
    if (!isRecord(raw) || !Array.isArray(raw.buckets)) return [];
    const windows = raw.buckets.flatMap((bucket): QuotaWindow[] => {
      if (!isRecord(bucket)) return [];
      const remaining = numberValue(bucket.remainingFraction);
      if (remaining === undefined) return [];
      const resetAt = epochMilliseconds(bucket.resetTime);
      return [{
        label: cleanText(bucket.displayName) ?? cleanText(bucket.bucketId) ?? "Quota",
        remainingPercent: clampPercent(remaining * 100),
        ...(resetAt !== undefined ? { resetAt } : {}),
      }];
    });
    return windows.length ? [{ name: cleanText(raw.displayName) ?? "Quota group", windows }] : [];
  });
}

function parseModels(payload: unknown): AntigravityModelQuota[] {
  if (!isRecord(payload) || !isRecord(payload.models)) return [];
  return Object.entries(payload.models).flatMap(([modelId, raw]): AntigravityModelQuota[] => {
    if (!isRecord(raw) || raw.isInternal === true || modelId.startsWith("chat_")) return [];
    const quota = isRecord(raw.quotaInfo) ? raw.quotaInfo : undefined;
    const fraction = numberValue(quota?.remainingFraction);
    if (fraction === undefined) return [];
    const resetAt = epochMilliseconds(quota?.resetTime);
    return [{
      modelId,
      ...(cleanText(raw.displayName) ? { displayName: cleanText(raw.displayName) } : {}),
      remainingPercent: clampPercent(fraction * 100),
      ...(resetAt !== undefined ? { resetAt } : {}),
    }];
  });
}

export function parseAntigravityQuota(
  assist: unknown,
  summary: unknown,
  available: unknown,
  capturedAt = Date.now(),
  summaryError?: string,
): AntigravityQuota {
  const tier = isRecord(assist)
    ? (isRecord(assist.paidTier) ? assist.paidTier : isRecord(assist.currentTier) ? assist.currentTier : undefined)
    : undefined;
  const plan = cleanText(tier?.name) ?? cleanText(tier?.id);
  const groups = parseWindows(summary);
  const models = parseModels(available);
  if (!groups.length && !models.length) throw new Error("Antigravity returned no quota information.");
  return { capturedAt, ...(plan ? { plan } : {}), groups, models, ...(summaryError ? { summaryError } : {}) };
}

async function post(
  path: string,
  token: string,
  body: object,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    if (signal.aborted) throw signal.reason;
    try {
      return await fetchJsonObject(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)",
        },
        body: JSON.stringify(body),
      }, { signal, timeoutMs });
    } catch (error) {
      lastError = error;
      if (error instanceof QuotaQueryError && ![403, 404, 429, 500, 502, 503, 504].includes(error.status ?? 0)) break;
    }
  }
  throw lastError ?? new Error("Antigravity endpoint unavailable.");
}

export async function queryAntigravityQuota(
  apiKey: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AntigravityQuota> {
  let parsed: unknown;
  try { parsed = JSON.parse(apiKey); } catch { throw new Error("Invalid Antigravity provider credential."); }
  if (!isRecord(parsed) || typeof parsed.token !== "string" || !parsed.token || typeof parsed.projectId !== "string" || !parsed.projectId) {
    throw new Error("Invalid Antigravity provider credential.");
  }
  const token = parsed.token;
  const project = parsed.projectId;
  const [assist, summary, models] = await Promise.allSettled([
    post("/v1internal:loadCodeAssist", token, METADATA, signal, timeoutMs),
    post("/v1internal:retrieveUserQuotaSummary", token, {}, signal, timeoutMs),
    post("/v1internal:fetchAvailableModels", token, { project }, signal, timeoutMs),
  ]);
  const summaryError = summary.status === "rejected" ? "Aggregate quota unavailable (may require a paid subscription)." : undefined;
  return parseAntigravityQuota(
    assist.status === "fulfilled" ? assist.value : undefined,
    summary.status === "fulfilled" ? summary.value : undefined,
    models.status === "fulfilled" ? models.value : undefined,
    Date.now(),
    summaryError,
  );
}
