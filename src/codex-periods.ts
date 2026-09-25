import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { configDirectory } from "./config.js";
import type { CodexQuota, QuotaAmountEstimate, QuotaAmountEstimates, QuotaWindow } from "./types.js";

export type CodexPeriodKind = "fiveHour" | "weekly";
export interface CodexPeriod {
  id: string;
  kind: CodexPeriodKind;
  plan?: string;
  startedAt: number; // First observation, not necessarily the actual reset time.
  lastAt: number;
  remainingPercent: number;
  resetAt?: number;
  closedAt?: number; // First observation of the next period.
  boundary?: "increase" | "reset-time" | "plan-change";
  estimatedTotalUsd?: number;
  estimateAsOf?: number;
  sampleStartAt?: number;
  sampleEndAt?: number;
  usedPercent?: number;
  piAttributedPercent?: number;
  calibrationPercent?: number;
  sampleIntervals?: number;
  quotaChanges?: number;
  excludedIntervals?: number;
  attribution?: "verified" | "correlated";
  /** 2 = plateau-aware weekly calibration; legacy weekly quotes are invalidated. */
  calibrationVersion?: 2;
}

const KINDS: CodexPeriodKind[] = ["fiveHour", "weekly"];
const MAX_PERIODS = 5000;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function valid(row: unknown): row is CodexPeriod {
  if (!row || typeof row !== "object") return false;
  const p = row as CodexPeriod;
  return KINDS.includes(p.kind) && p.id === `${p.kind}:${p.startedAt}`
    && finite(p.startedAt) && finite(p.lastAt) && p.startedAt > 0 && p.lastAt >= p.startedAt
    && finite(p.remainingPercent) && p.remainingPercent >= 0 && p.remainingPercent <= 100
    && (p.plan === undefined || (typeof p.plan === "string" && p.plan.length <= 512))
    && (p.resetAt === undefined || finite(p.resetAt))
    && (p.closedAt === undefined || (finite(p.closedAt) && p.closedAt > p.lastAt))
    && (p.boundary === undefined || ["increase", "reset-time", "plan-change"].includes(p.boundary))
    && (p.estimatedTotalUsd === undefined || (finite(p.estimatedTotalUsd) && p.estimatedTotalUsd >= 0))
    && (p.estimateAsOf === undefined || finite(p.estimateAsOf))
    && (p.sampleStartAt === undefined || finite(p.sampleStartAt))
    && (p.sampleEndAt === undefined || finite(p.sampleEndAt))
    && (p.usedPercent === undefined || finite(p.usedPercent))
    && (p.piAttributedPercent === undefined || (finite(p.piAttributedPercent) && p.piAttributedPercent > 0))
    && (p.calibrationPercent === undefined || (finite(p.calibrationPercent) && p.calibrationPercent > 0))
    && (p.sampleIntervals === undefined || (Number.isSafeInteger(p.sampleIntervals) && p.sampleIntervals > 0))
    && (p.quotaChanges === undefined || (Number.isSafeInteger(p.quotaChanges) && p.quotaChanges > 0))
    && (p.excludedIntervals === undefined || (Number.isSafeInteger(p.excludedIntervals) && p.excludedIntervals >= 0))
    && (p.attribution === undefined || ["verified", "correlated"].includes(p.attribution))
    && (p.calibrationVersion === undefined || p.calibrationVersion === 2)
    && (p.attribution !== "verified" || (finite(p.piAttributedPercent) && p.piAttributedPercent > 0));
}

/** Any observed increase starts a new period, even if the advertised reset time did not change. */
export function periodBoundary(prior: { remainingPercent: number; resetAt?: number; plan?: string },
  next: { remainingPercent: number; resetAt?: number; plan?: string }): CodexPeriod["boundary"] {
  if (prior.plan?.toLowerCase() !== next.plan?.toLowerCase()) return "plan-change";
  if (next.remainingPercent > prior.remainingPercent) return "increase";
  if (prior.resetAt !== undefined && next.resetAt !== undefined && Math.abs(prior.resetAt - next.resetAt) > 60_000) return "reset-time";
  return undefined;
}

export function advanceCodexPeriods(
  existing: CodexPeriod[], readings: CodexQuota[], estimates?: QuotaAmountEstimates["codex"],
): CodexPeriod[] {
  // Remove unlabeled legacy quotes and pre-plateau weekly quotes. The latter
  // omitted Pi usage while the weekly percentage was unchanged.
  const periods = existing.map((p) => {
    if ((p.kind !== "weekly" || p.calibrationVersion === 2)
      && (p.piAttributedPercent !== undefined || p.attribution === "correlated")) return { ...p };
    const { estimatedTotalUsd: _old, estimateAsOf: _at, sampleStartAt: _start,
      sampleEndAt: _end, usedPercent: _drop, piAttributedPercent: _pi,
      calibrationPercent: _calibration, sampleIntervals: _samples, quotaChanges: _changes,
      excludedIntervals: _excluded, attribution: _attribution, calibrationVersion: _version, ...safe } = p;
    return { ...safe } as CodexPeriod;
  });
  const lastByKind = new Map(KINDS.map((kind) => [kind, [...periods].reverse().find((p) => p.kind === kind)] as const));
  const sorted = [...new Map(readings.filter((q) => finite(q.capturedAt) && q.capturedAt > 0).map((q) => [q.capturedAt, q])).values()]
    .sort((a, b) => a.capturedAt - b.capturedAt);
  for (const reading of sorted) {
    for (const kind of KINDS) {
      const window: QuotaWindow | undefined = reading[kind];
      if (!window || !finite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100) continue;
      const previous = lastByKind.get(kind);
      if (previous && reading.capturedAt <= previous.lastAt) continue;
      const boundary = previous && periodBoundary(previous, { ...window, plan: reading.plan });
      if (previous && boundary) { previous.closedAt = reading.capturedAt; previous.boundary = boundary; }
      if (!previous || boundary) {
        const next: CodexPeriod = { id: `${kind}:${reading.capturedAt}`, kind, plan: reading.plan,
          startedAt: reading.capturedAt, lastAt: reading.capturedAt,
          remainingPercent: window.remainingPercent, ...(finite(window.resetAt) ? { resetAt: window.resetAt } : {}) };
        periods.push(next);
        lastByKind.set(kind, next);
      } else {
        previous.lastAt = reading.capturedAt;
        previous.remainingPercent = window.remainingPercent;
        if (finite(window.resetAt)) previous.resetAt = window.resetAt;
      }
    }
  }
  // Keep the latest eligible sample within the active period, even when a later
  // account-only decline was excluded from calibration.
  const latest = sorted.at(-1);
  if (latest && estimates) for (const kind of KINDS) {
    const period = lastByKind.get(kind);
    const estimate: QuotaAmountEstimate = estimates[kind];
    if (period && !period.closedAt && latest[kind] && period.lastAt === latest.capturedAt
      && finite(estimate.sampleEndAt) && estimate.sampleEndAt <= latest.capturedAt
      && estimate.sampleEndAt >= period.startedAt && finite(estimate.estimatedPeriodUsd)
      && estimate.estimatedPeriodUsd >= 0 && finite(estimate.sampleStartAt)
      && estimate.sampleStartAt >= period.startedAt && finite(estimate.usedPercent)
      && (estimate.attribution === "correlated" || (estimate.attribution === "verified"
        && finite(estimate.piAttributedPercent) && estimate.piAttributedPercent > 0))
      && finite(estimate.calibrationPercent) && estimate.calibrationPercent > 0) {
      period.estimatedTotalUsd = estimate.estimatedPeriodUsd;
      period.estimateAsOf = latest.capturedAt;
      period.sampleStartAt = estimate.sampleStartAt;
      period.sampleEndAt = estimate.sampleEndAt;
      period.usedPercent = estimate.usedPercent;
      period.calibrationPercent = estimate.calibrationPercent;
      period.sampleIntervals = estimate.sampleIntervals;
      period.quotaChanges = estimate.quotaChanges;
      period.excludedIntervals = estimate.excludedIntervals;
      period.attribution = estimate.attribution;
      if (kind === "weekly") period.calibrationVersion = 2;
      if (estimate.attribution === "verified" && finite(estimate.piAttributedPercent)) period.piAttributedPercent = estimate.piAttributedPercent;
      else delete period.piAttributedPercent;
    }
  }
  return periods.slice(-MAX_PERIODS);
}

/** Account-scoped, credential-free atomic snapshots. Replaying saved readings is idempotent. */
export class CodexPeriodStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(accountId: string, root = configDirectory()) {
    const scope = createHash("sha256").update(accountId).digest("hex");
    this.directory = join(root, "codex-periods");
    this.path = join(this.directory, `${scope}.json`);
  }

  async load(): Promise<CodexPeriod[]> {
    return this.readPeriods().then((periods) => periods.map((p) => {
      if ((p.kind !== "weekly" || p.calibrationVersion === 2)
        && (p.piAttributedPercent !== undefined || p.attribution === "correlated")) return p;
      const { estimatedTotalUsd: _old, estimateAsOf: _at, sampleStartAt: _start,
        sampleEndAt: _end, usedPercent: _drop, piAttributedPercent: _pi,
        calibrationPercent: _calibration, sampleIntervals: _samples, quotaChanges: _changes,
        excludedIntervals: _excluded, attribution: _attribution, calibrationVersion: _version, ...safe } = p;
      return safe;
    }));
  }

  private async readPeriods(): Promise<CodexPeriod[]> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid period history");
        const value: unknown = JSON.parse(await file.readFile("utf8"));
        if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("Invalid period history");
        const rows = (value as { periods?: unknown }).periods;
        if (!Array.isArray(rows) || rows.length > MAX_PERIODS || !rows.every(valid)) throw new Error("Invalid period history");
        return rows.map(({ id, kind, plan, startedAt, lastAt, remainingPercent, resetAt, closedAt, boundary,
          estimatedTotalUsd, estimateAsOf, sampleStartAt, sampleEndAt, usedPercent, piAttributedPercent, calibrationPercent, sampleIntervals, quotaChanges, excludedIntervals, attribution, calibrationVersion }: CodexPeriod) =>
          ({ id, kind, plan, startedAt, lastAt, remainingPercent, resetAt, closedAt, boundary,
            estimatedTotalUsd, estimateAsOf, sampleStartAt, sampleEndAt, usedPercent, piAttributedPercent, calibrationPercent, sampleIntervals, quotaChanges, excludedIntervals, attribution, calibrationVersion }));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async update(readings: CodexQuota[], estimates: QuotaAmountEstimates["codex"]): Promise<CodexPeriod[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, { realpath: false, retries: { retries: 5, minTimeout: 20 }, stale: 30_000 });
    const tmp = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const before = await this.readPeriods();
      const after = advanceCodexPeriods(before, readings, estimates);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await writeFile(tmp, JSON.stringify({ version: 1, periods: after }) + "\n", { mode: 0o600, flag: "wx" });
        await rename(tmp, this.path);
      }
      return after;
    } finally { try { await rm(tmp, { force: true }); } finally { await release(); } }
  }
}
