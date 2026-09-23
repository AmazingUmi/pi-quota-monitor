import { constants, createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory } from "../config.js";
import type { TokenTotals, TokenUsageRecord } from "../types.js";
import { accumulate, emptyTotals } from "./collector.js";
import { localDate } from "./store.js";
import { estimateRecordCost, PRICE_DATE } from "./pricing.js";

export interface ModelUsage extends TokenTotals {
  provider: string; model: string;
  estimatedCostUsd: number; pricedRecords: number; unpricedRecords: number; unpricedTokens: number;
}
export interface TimeBucket { bucket: string; provider: string; model: string; totalTokens: number }
export interface UsageSummary {
  totals: TokenTotals;
  models: ModelUsage[];
  timeline: { hours: TimeBucket[]; days: TimeBucket[]; today: string; currentHour: number };
  pricing: { asOf: string; estimatedCostUsd: number; pricedRecords: number; unpricedRecords: number; unpricedTokens: number };
  records: number;
  invalidRecords: number;
  updatedAt?: number;
  stale: boolean;
  error?: string;
}

interface PeriodCost {
  timestamp: number;
  provider: string;
  estimatedCostUsd: number;
  pricedRecords: number;
  unpricedRecords: number;
  unpricedTokens: number;
}

export interface PeriodCostSummary {
  estimatedCostUsd: number;
  pricedRecords: number;
  unpricedRecords: number;
  unpricedTokens: number;
}

interface FileState {
  dev: number;
  ino: number;
  offset: number;
  pending: Buffer;
  discarding: boolean;
  records: number;
  invalidRecords: number;
  models: Map<string, ModelUsage>;
  hours: Map<string, TimeBucket>;
  periodCosts: Map<string, PeriodCost>;
}

const FILE_NAME = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_LINE = 1024 * 1024;
const PERIOD_COST_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const keyFor = (provider: string, model: string) => JSON.stringify([provider, model]);

function validRecord(value: unknown, day: string): value is TokenUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TokenUsageRecord>;
  return typeof record.timestamp === "number" && Number.isFinite(record.timestamp) && localDate(record.timestamp) === day
    && typeof record.provider === "string" && record.provider.length > 0
    && typeof record.model === "string" && record.model.length > 0
    && (["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"] as const)
      .every((field) => typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] >= 0);
}

/** Incremental, transactional ledger reader. A cursor is committed only after the full scan succeeds. */
export class UsageAggregator {
  private files = new Map<string, FileState>();
  private summary: UsageSummary = { totals: emptyTotals(), models: [], timeline: { hours: [], days: [], today: localDate(Date.now()), currentHour: Math.floor(Date.now() / 3_600_000) * 3_600_000 }, pricing: { asOf: PRICE_DATE, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 }, records: 0, invalidRecords: 0, stale: false };
  private inFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(private readonly directory = configDirectory(), private readonly accountId?: string | null) {}

  state(): UsageSummary { return this.summary; }

  estimateCostForPeriod(provider: string, startAt: number, endAt = Date.now()): PeriodCostSummary {
    const result = { estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };
    for (const state of this.files.values()) {
      for (const item of state.periodCosts.values()) {
        if (item.provider !== provider || item.timestamp < startAt || item.timestamp >= endAt) continue;
        result.estimatedCostUsd += item.estimatedCostUsd;
        result.pricedRecords += item.pricedRecords;
        result.unpricedRecords += item.unpricedRecords;
        result.unpricedTokens += item.unpricedTokens;
      }
    }
    return result;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh(); }, 5000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const task = this.scan().then((result) => { this.summary = result.summary; this.files = result.files; }).catch(() => {
      this.summary = { ...this.summary, stale: true, error: "Token 汇总暂不可用，显示上次有效结果" };
    });
    this.inFlight = task.finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async scan(): Promise<{ files: Map<string, FileState>; summary: UsageSummary }> {
    let names: string[];
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      names = entries.filter((entry) => entry.isFile() && FILE_NAME.test(entry.name)).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    const files = new Map<string, FileState>();
    const now = Date.now();
    const firstHour = Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
    const days = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      days.add(localDate(date.getTime()));
    }
    for (const name of names) {
      const handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const previous = this.files.get(name);
        const state: FileState = previous && previous.dev === stat.dev && previous.ino === stat.ino && stat.size >= previous.offset
          ? { ...previous, pending: Buffer.from(previous.pending), models: new Map(previous.models), hours: new Map(previous.hours), periodCosts: new Map(previous.periodCosts) }
          : { dev: stat.dev, ino: stat.ino, offset: 0, pending: Buffer.alloc(0), discarding: false, records: 0, invalidRecords: 0, models: new Map(), hours: new Map(), periodCosts: new Map() };
        const day = FILE_NAME.exec(name)![1];
        if (stat.size > state.offset) {
          let bytes = 0;
          const stream = createReadStream("", { fd: handle.fd, autoClose: false, start: state.offset, end: stat.size - 1 });
          for await (const chunk of stream) {
            bytes += chunk.length;
            this.consume(state, chunk, day);
          }
          if (bytes !== stat.size - state.offset) throw new Error("Ledger changed during scan");
          state.offset = stat.size;
        }
        for (const [key, item] of state.hours) {
          if (Number(item.bucket) < firstHour) state.hours.delete(key);
        }
        for (const [key, item] of state.periodCosts) {
          if (item.timestamp < now - PERIOD_COST_RETENTION_MS) state.periodCosts.delete(key);
        }
        files.set(name, state);
      } finally { await handle.close(); }
    }
    const totals = emptyTotals();
    const models = new Map<string, ModelUsage>();
    const daily = new Map<string, TimeBucket>();
    const hourly = new Map<string, TimeBucket>();
    let records = 0;
    let invalidRecords = 0;
    for (const [name, state] of files) {
      const day = FILE_NAME.exec(name)![1];
      records += state.records;
      invalidRecords += state.invalidRecords;
      for (const item of state.models.values()) {
        const key = keyFor(item.provider, item.model);
        const old = models.get(key);
        models.set(key, { ...item, ...accumulate(old ?? emptyTotals(), item),
          estimatedCostUsd: (old?.estimatedCostUsd ?? 0) + item.estimatedCostUsd,
          pricedRecords: (old?.pricedRecords ?? 0) + item.pricedRecords,
          unpricedRecords: (old?.unpricedRecords ?? 0) + item.unpricedRecords,
          unpricedTokens: (old?.unpricedTokens ?? 0) + item.unpricedTokens });
        if (days.has(day)) {
          const bucketKey = JSON.stringify([day, item.provider, item.model]);
          const prior = daily.get(bucketKey);
          daily.set(bucketKey, { bucket: day, provider: item.provider, model: item.model, totalTokens: (prior?.totalTokens ?? 0) + item.totalTokens });
        }
      }
      for (const item of state.hours.values()) {
        if (Number(item.bucket) < firstHour || Number(item.bucket) > now) continue;
        const bucketKey = JSON.stringify([item.bucket, item.provider, item.model]);
        const prior = hourly.get(bucketKey);
        hourly.set(bucketKey, { ...item, totalTokens: (prior?.totalTokens ?? 0) + item.totalTokens });
      }
    }
    const sorted = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    for (const item of sorted) Object.assign(totals, accumulate(totals, item));
    const pricing = sorted.reduce((result, item) => ({ asOf: PRICE_DATE,
      estimatedCostUsd: result.estimatedCostUsd + item.estimatedCostUsd,
      pricedRecords: result.pricedRecords + item.pricedRecords,
      unpricedRecords: result.unpricedRecords + item.unpricedRecords,
      unpricedTokens: result.unpricedTokens + item.unpricedTokens,
    }), { asOf: PRICE_DATE, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 });
    const order = (a: TimeBucket, b: TimeBucket) => a.bucket.localeCompare(b.bucket) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    return { files, summary: { totals, models: sorted, timeline: { hours: [...hourly.values()].sort(order), days: [...daily.values()].sort(order), today: localDate(now), currentHour: firstHour + 23 * 3_600_000 }, pricing, records, invalidRecords, updatedAt: Date.now(), stale: false } };
  }

  private consume(state: FileState, chunk: Buffer, day: string): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      const line = state.pending.length ? Buffer.concat([state.pending, part]) : part;
      if (state.discarding || line.length > MAX_LINE) state.invalidRecords++;
      else if (line.length) {
        try {
          const value: unknown = JSON.parse(line.toString("utf8"));
          if (!validRecord(value, day)) throw new Error("Invalid record");
          // Legacy Codex entries without an account ID are intentionally unassigned.
          if (this.accountId !== undefined && value.provider === "openai-codex"
            && (this.accountId === null ? value.accountId !== undefined : value.accountId !== this.accountId)) {
            state.pending = Buffer.alloc(0);
            state.discarding = false;
            start = i + 1;
            continue;
          }
          const key = keyFor(value.provider, value.model);
          const prior = state.models.get(key) ?? { provider: value.provider, model: value.model, ...emptyTotals(), estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0, unpricedTokens: 0 };
          const cost = estimateRecordCost(value);
          if (value.timestamp >= Date.now() - PERIOD_COST_RETENTION_MS) {
            const costKey = JSON.stringify([value.timestamp, value.provider]);
            const periodCost = state.periodCosts.get(costKey);
            state.periodCosts.set(costKey, {
              timestamp: value.timestamp,
              provider: value.provider,
              estimatedCostUsd: (periodCost?.estimatedCostUsd ?? 0) + (cost ?? 0),
              pricedRecords: (periodCost?.pricedRecords ?? 0) + (cost === undefined ? 0 : 1),
              unpricedRecords: (periodCost?.unpricedRecords ?? 0) + (cost === undefined ? 1 : 0),
              unpricedTokens: (periodCost?.unpricedTokens ?? 0) + (cost === undefined ? value.totalTokens : 0),
            });
          }
          state.models.set(key, { ...prior, ...accumulate(prior, value),
            estimatedCostUsd: prior.estimatedCostUsd + (cost ?? 0),
            pricedRecords: prior.pricedRecords + (cost === undefined ? 0 : 1),
            unpricedRecords: prior.unpricedRecords + (cost === undefined ? 1 : 0),
            unpricedTokens: prior.unpricedTokens + (cost === undefined ? value.totalTokens : 0) });
          const hour = Math.floor(value.timestamp / 3_600_000) * 3_600_000;
          if (hour >= Date.now() - 25 * 3_600_000) {
            const bucket = String(hour);
            const hourKey = JSON.stringify([bucket, value.provider, value.model]);
            const previous = state.hours.get(hourKey);
            state.hours.set(hourKey, { bucket, provider: value.provider, model: value.model, totalTokens: (previous?.totalTokens ?? 0) + value.totalTokens });
          }
          state.records++;
        } catch { state.invalidRecords++; }
      }
      state.pending = Buffer.alloc(0);
      state.discarding = false;
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    if (!state.discarding && state.pending.length + rest.length > MAX_LINE) {
      state.pending = Buffer.alloc(0);
      state.discarding = true;
    } else if (!state.discarding && rest.length) {
      state.pending = Buffer.concat([state.pending, rest]);
    }
  }
}
