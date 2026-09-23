export class QuotaQueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QuotaQueryError";
  }
}

export async function fetchJsonObject(
  url: string,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs: number; maxBytes?: number },
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, redirect: "error", signal });
  const text = await response.text();
  if (text.length > (options.maxBytes ?? 65_536)) {
    throw new QuotaQueryError("Quota response was too large.", response.status);
  }
  if (!response.ok) {
    throw new QuotaQueryError(`Quota endpoint returned HTTP ${response.status}.`, response.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QuotaQueryError("Quota endpoint returned invalid JSON.", response.status);
  }
  if (!isRecord(parsed)) throw new QuotaQueryError("Quota response was not an object.");
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function cleanText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, maxLength);
  return text || undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function epochMilliseconds(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) {
    return Math.floor(numeric >= 1_000_000_000_000 ? numeric : numeric * 1000);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
