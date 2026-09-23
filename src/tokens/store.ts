import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory } from "../config.js";
import type { TokenTotals, TokenUsageRecord } from "../types.js";
import { accumulate, emptyTotals } from "./collector.js";

export function localDate(timestamp: number): string {
  const now = new Date(timestamp);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function ledgerPath(day: string): string {
  return join(configDirectory(), `usage-${day}.jsonl`);
}

export async function appendUsage(record: TokenUsageRecord): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await appendFile(ledgerPath(localDate(record.timestamp)), JSON.stringify(record) + "\n", { mode: 0o600 });
}

export async function readDailyUsage(day = localDate(Date.now())): Promise<TokenTotals> {
  let content: string;
  try { content = await readFile(ledgerPath(day), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyTotals();
    throw error;
  }
  return content.split("\n").reduce((totals, line) => {
    if (!line) return totals;
    try {
      const record = JSON.parse(line) as TokenUsageRecord;
      if (localDate(record.timestamp) !== day || ![record.input, record.output, record.reasoning, record.cacheRead, record.cacheWrite, record.totalTokens].every(Number.isFinite)) return totals;
      return accumulate(totals, record);
    } catch { return totals; }
  }, emptyTotals());
}
