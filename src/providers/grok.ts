import { createHash } from "node:crypto";
import type { GrokQuota, QuotaWindow } from "../types.js";
import { cleanText, epochMilliseconds, fetchJsonObject, isRecord, numberValue } from "./http.js";

// Grok CLI billing is not a public xAI API. Keep the host fixed and fail closed
// if the payload no longer contains a shared credit window.
const ORIGIN = "https://cli-chat-proxy.grok.com";

function jwtPayload(access: string): Record<string, unknown> | undefined {
  const parts = access.split(".");
  if (parts.length !== 3 || !parts[1]) return;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

/** Opaque local scope. Raw subject and team identifiers are never stored. */
export function grokAccountId(access: string): string | undefined {
  const payload = jwtPayload(access);
  const subject = payload?.sub;
  const team = payload?.team_id;
  if (typeof subject !== "string" || !subject || subject.length > 128
    || typeof team !== "string" || !team || team.length > 128) return;
  return createHash("sha256").update(JSON.stringify([subject, team])).digest("hex");
}

export function parseGrokPlan(payload: unknown): string | undefined {
  return isRecord(payload) ? cleanText(payload.subscription_tier_display, 80) : undefined;
}

function period(config: Record<string, unknown>): { start?: number; end?: number; type?: string } {
  const current = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  return {
    start: epochMilliseconds(current?.start) ?? epochMilliseconds(config.billingPeriodStart),
    end: epochMilliseconds(current?.end) ?? epochMilliseconds(config.billingPeriodEnd),
    type: cleanText(current?.type),
  };
}

function windowLabel(type: string | undefined, minutes: number | undefined): QuotaWindow["label"] {
  const normalized = type?.toUpperCase() ?? "";
  if (normalized.includes("WEEK")) return "weekly";
  if (normalized.includes("MONTH")) return "monthly";
  if (minutes !== undefined && minutes >= 4 * 24 * 60 && minutes <= 12 * 24 * 60) return "weekly";
  if (minutes !== undefined && minutes >= 20 * 24 * 60 && minutes <= 45 * 24 * 60) return "monthly";
  return "credits";
}

export function parseGrokQuota(payload: unknown, plan?: string, capturedAt = Date.now()): GrokQuota {
  if (!isRecord(payload) || !isRecord(payload.config)) throw new Error("Invalid Grok quota response.");
  const used = numberValue(payload.config.creditUsagePercent);
  const bounds = period(payload.config);
  // An omitted proto3 percentage with a current period is zero usage, not an unknown window.
  if ((used === undefined && bounds.end === undefined) || (used !== undefined && (used < 0 || used > 100))) {
    throw new Error("Grok returned no quota windows.");
  }
  const windowMinutes = bounds.start !== undefined && bounds.end !== undefined && bounds.end > bounds.start
    ? Math.round((bounds.end - bounds.start) / 60_000) : undefined;
  return {
    capturedAt,
    ...(plan ? { plan } : {}),
    credit: {
      label: windowLabel(bounds.type, windowMinutes),
      remainingPercent: 100 - (used ?? 0),
      ...(bounds.end !== undefined ? { resetAt: bounds.end } : {}),
      ...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes } : {}),
    },
  };
}

export async function queryGrokQuota(
  access: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ quota: GrokQuota; accountId?: string }> {
  if (!access || /\s/.test(access)) throw new Error("Grok OAuth credential unavailable.");
  const headers = { Authorization: `Bearer ${access}`, Accept: "application/json" };
  const billing = await fetchJsonObject(`${ORIGIN}/v1/billing?format=credits`, { headers }, { signal, timeoutMs });
  let plan: string | undefined;
  try {
    plan = parseGrokPlan(await fetchJsonObject(`${ORIGIN}/v1/settings`, { headers }, { signal, timeoutMs }));
  } catch { /* A missing plan must not hide a valid credit window. */ }
  const accountId = grokAccountId(access);
  return { quota: parseGrokQuota(billing, plan), ...(accountId ? { accountId } : {}) };
}
