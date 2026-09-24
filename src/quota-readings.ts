import { constants } from "node:fs";
import { appendFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { configDirectory } from "./config.js";
import type { AntigravityQuota, CodexQuota, QuotaWindow } from "./types.js";

interface Quotas { codex: CodexQuota; antigravity: AntigravityQuota }
const DAY = 86_400_000;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 512;
function windowValue(value: unknown): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as QuotaWindow;
  if (!text(v.label) || !finite(v.remainingPercent) || v.remainingPercent < 0 || v.remainingPercent > 100) return;
  return { label: v.label, remainingPercent: v.remainingPercent,
    ...(finite(v.resetAt) ? { resetAt: v.resetAt } : {}),
    ...(finite(v.windowMinutes) && v.windowMinutes > 0 ? { windowMinutes: v.windowMinutes } : {}) };
}
/** Explicit allowlist: provider payloads and credentials never enter the reading journal. */
function clean<K extends keyof Quotas>(provider: K, value: unknown): Quotas[K] | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as CodexQuota & AntigravityQuota;
  if (!finite(v.capturedAt) || v.capturedAt <= 0) return;
  const base = { capturedAt: v.capturedAt, ...(text(v.plan) ? { plan: v.plan } : {}) };
  if (provider === "codex") return { ...base, fiveHour: windowValue(v.fiveHour), weekly: windowValue(v.weekly) } as Quotas[K];
  if (!Array.isArray(v.groups) || !Array.isArray(v.models)) return;
  return { ...base,
    groups: v.groups.slice(0, 100).flatMap((group) => group && text(group.name) && Array.isArray(group.windows)
      ? [{ name: group.name, windows: group.windows.slice(0, 20).map(windowValue).filter((w): w is QuotaWindow => !!w) }] : []),
    models: v.models.slice(0, 1000).flatMap((model) => model && text(model.modelId) ? [{ modelId: model.modelId,
      ...(text(model.displayName) ? { displayName: model.displayName } : {}),
      ...(finite(model.remainingPercent) && model.remainingPercent >= 0 && model.remainingPercent <= 100 ? { remainingPercent: model.remainingPercent } : {}),
      ...(finite(model.resetAt) ? { resetAt: model.resetAt } : {}) }] : []),
    ...(text(v.summaryError) ? { summaryError: v.summaryError } : {}),
  } as Quotas[K];
}

async function readPrivate(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid reading file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

/** Append-only daily observations plus an atomic last-success snapshot, isolated by Codex account. */
export class QuotaReadings<K extends keyof Quotas> {
  private readonly directory: string;
  constructor(private readonly provider: K, accountId?: string, root = configDirectory()) {
    const scope = provider === "codex" ? createHash("sha256").update(accountId ?? "unassigned").digest("hex") : "shared";
    this.directory = join(root, "quota-readings", `${provider}-${scope}`);
  }

  async load(now = Date.now()): Promise<Quotas[K][]> {
    const readings: Quotas[K][] = [];
    // A much older last reading remains useful for display, but never for a new-cycle estimate.
    try { const last = clean(this.provider, JSON.parse(await readPrivate(join(this.directory, "latest.json")))); if (last) readings.push(last); }
    catch { /* Missing/damaged cache must not prevent a live query. */ }
    for (let i = 0; i < 9; i++) {
      const day = new Date(now - i * DAY).toISOString().slice(0, 10);
      let lines: string;
      try { lines = await readPrivate(join(this.directory, `readings-${day}.jsonl`)); } catch { continue; }
      for (const line of lines.split("\n")) {
        try { const value = clean(this.provider, JSON.parse(line)); if (value && value.capturedAt <= now) readings.push(value); }
        catch { /* Recover earlier complete observations after a truncated write. */ }
      }
    }
    return [...new Map(readings.filter((v) => v.capturedAt <= now).map((v) => [v.capturedAt, v])).values()].sort((a, b) => a.capturedAt - b.capturedAt);
  }

  async append(value: Quotas[K]): Promise<void> {
    const reading = clean(this.provider, value);
    if (!reading) throw new Error("Invalid quota reading");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, { realpath: false, retries: { retries: 5, minTimeout: 20 }, stale: 30_000 });
    const tmp = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const day = new Date(reading.capturedAt).toISOString().slice(0, 10);
      // NOFOLLOW and O_APPEND avoid following user-created links or truncating earlier observations.
      const handle = await open(join(this.directory, `readings-${day}.jsonl`), constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const size = (await handle.stat()).size;
        const tail = Buffer.alloc(1);
        if (size) await handle.read(tail, 0, 1, size - 1);
        // Preserve complete future reads even when an earlier process left a torn final line.
        await appendFile(handle, `${size && tail[0] !== 10 ? "\n" : ""}${JSON.stringify(reading)}\n`);
      } finally { await handle.close(); }
      let previous: Quotas[K] | undefined;
      try { previous = clean(this.provider, JSON.parse(await readPrivate(join(this.directory, "latest.json")))); } catch { /* Replace a damaged snapshot. */ }
      if (!previous || reading.capturedAt >= previous.capturedAt) {
        await writeFile(tmp, JSON.stringify(reading) + "\n", { mode: 0o600, flag: "wx" });
        await rename(tmp, join(this.directory, "latest.json"));
      }
    } finally { try { await rm(tmp, { force: true }); } finally { await release(); } }
  }
}
