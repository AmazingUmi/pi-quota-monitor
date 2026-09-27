import { createHash } from "node:crypto";
import type { ClaudeQuota, QuotaWindow } from "../types.js";
import { epochMilliseconds, fetchJsonObject, isRecord, numberValue } from "./http.js";

// These Claude Code OAuth endpoints are not part of Anthropic's public API contract.
// Keep their host fixed and fail closed if their response shape changes.
const ORIGIN = "https://api.anthropic.com";
const HEADERS = { "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };

function window(value: unknown, label: string, windowMinutes: number): QuotaWindow | undefined {
  if (!isRecord(value)) return;
  const used = numberValue(value.utilization);
  if (used === undefined || used < 0 || used > 100) return;
  const resetAt = epochMilliseconds(value.resets_at);
  return { label, windowMinutes, remainingPercent: 100 - used, ...(resetAt !== undefined ? { resetAt } : {}) };
}

export function parseClaudeQuota(payload: unknown, capturedAt = Date.now()): ClaudeQuota {
  if (!isRecord(payload)) throw new Error("Invalid Claude quota response.");
  const fiveHour = window(payload.five_hour, "5h", 300);
  const weekly = window(payload.seven_day, "weekly", 10080);
  if (!fiveHour && !weekly) throw new Error("Claude returned no quota windows.");
  return { capturedAt, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

/** Opaque, stable local scope; neither UUID nor email is written to quota files or the dashboard. */
export function parseClaudeIdentity(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.account) || !isRecord(payload.organization)) return;
  const account = payload.account.uuid;
  const organization = payload.organization.uuid;
  if (typeof account !== "string" || !account || account.length > 128
    || typeof organization !== "string" || !organization || organization.length > 128) return;
  return createHash("sha256").update(JSON.stringify([account, organization])).digest("hex");
}

export async function queryClaudeQuota(access: string, signal: AbortSignal, timeoutMs: number): Promise<{ quota: ClaudeQuota; accountId?: string }> {
  if (!access || /\s/.test(access)) throw new Error("Claude OAuth credential unavailable.");
  const headers = { ...HEADERS, Authorization: `Bearer ${access}` };
  // A profile failure must not hide valid quota, but it must disable account-bound history/estimates.
  const quotaPayload = await fetchJsonObject(`${ORIGIN}/api/oauth/usage`, { headers }, { signal, timeoutMs });
  const quota = parseClaudeQuota(quotaPayload);
  let accountId: string | undefined;
  try {
    const profile = await fetchJsonObject(`${ORIGIN}/api/oauth/profile`, { headers }, { signal, timeoutMs });
    accountId = parseClaudeIdentity(profile);
  } catch { /* No trustworthy account identity: do not persist or estimate. */ }
  return { quota, ...(accountId ? { accountId } : {}) };
}
