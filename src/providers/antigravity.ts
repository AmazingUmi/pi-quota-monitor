import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

// pi-antigravity's local agy provider does not expose OAuth credentials: /agy-usage
// runs `agy --print /usage --output-format json` against agy's own logged-in session.
export function parseNativeAntigravityQuota(text: string, capturedAt = Date.now()): AntigravityQuota {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("Invalid agy usage response."); }
  if (!isRecord(payload)) throw new Error("Invalid agy usage response.");
  const result = payload.event === "result" && isRecord(payload.result) ? payload.result : payload;
  if (result.status !== undefined && result.status !== "SUCCESS" && result.status !== "OK") {
    throw new Error("agy usage command failed.");
  }
  const command = isRecord(result.command) ? result.command : undefined;
  if (command?.name !== undefined && command.name !== "usage") throw new Error("Unexpected agy command response.");
  const data = isRecord(command?.data) ? command.data : isRecord(result.data) ? result.data : undefined;
  if (!data || !Array.isArray(data.groups)) throw new Error("agy returned no quota groups.");
  const groups: AntigravityQuotaGroup[] = data.groups.flatMap((raw): AntigravityQuotaGroup[] => {
    if (!isRecord(raw) || !Array.isArray(raw.buckets)) return [];
    const windows: QuotaWindow[] = raw.buckets.flatMap((bucket): QuotaWindow[] => {
      if (!isRecord(bucket)) return [];
      const fraction = numberValue(bucket.remaining_fraction ?? bucket.remainingFraction ?? bucket.remaining);
      if (fraction === undefined) return [];
      const resetAt = epochMilliseconds(bucket.reset_time ?? bucket.resetTime);
      return [{ label: cleanText(bucket.name) ?? cleanText(bucket.id) ?? "Quota",
        remainingPercent: clampPercent(fraction * 100), ...(resetAt !== undefined ? { resetAt } : {}) }];
    });
    return windows.length ? [{ name: cleanText(raw.name) ?? "Quota group", windows }] : [];
  });
  if (!groups.length) throw new Error("agy returned no quota groups.");
  return { capturedAt, groups, models: [] };
}

async function agyBinary(): Promise<string> {
  // AGY_BINARY is pi-antigravity's own override. Do not execute through a shell.
  if (process.env.AGY_BINARY !== undefined) return process.env.AGY_BINARY;
  const names = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "agy"));
  names.push(path.join(os.homedir(), ".gemini", "bin", process.platform === "win32" ? "agy.exe" : "agy"));
  for (const name of names) {
    try { await access(name, constants.X_OK); return name; } catch { /* Try the next candidate. */ }
  }
  throw new Error("agy binary unavailable.");
}

function runAgy(binary: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill();
      } catch { /* Already exited. */ }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output);
    };
    const onAbort = () => { stop(); finish(new Error("agy usage aborted.")); };
    const timer = setTimeout(() => { stop(); finish(new Error("agy usage timed out.")); }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024 * 1024) { stop(); finish(new Error("agy usage response too large.")); }
    });
    child.on("error", () => finish(new Error("agy binary failed to start.")));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("agy usage command failed.")));
  });
}

export async function queryNativeAntigravityQuota(signal: AbortSignal, timeoutMs: number): Promise<AntigravityQuota> {
  const binary = await agyBinary();
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const text = await runAgy(binary, ["--print", "/usage", "--output-format", "json", "--print-timeout", `${seconds}s`], signal, timeoutMs);
  return parseNativeAntigravityQuota(text);
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
