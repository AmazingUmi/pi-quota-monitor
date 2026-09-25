import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { usageDirectory } from "../config.js";
import type { TokenTotals, TokenUsageRecord } from "../types.js";
import { accumulate, emptyTotals } from "./collector.js";
import { withLedgerLock } from "../history.js";

export function localDate(timestamp: number): string {
  const now = new Date(timestamp);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function ledgerPath(day: string): string {
  return join(usageDirectory(), `usage-${day}.jsonl`);
}

export function usageIdentity(record: TokenUsageRecord): string | undefined {
  if (!record.sessionId) return undefined;
  // The same assistant turn can arrive through an ambient message_end and a child session file.
  // Aggregate-only CLI receipts have no message timestamp; runId is their stable identity.
  return record.model === "unknown-subagent" && record.runId
    ? JSON.stringify(["run", record.sessionId, record.runId])
    : JSON.stringify(["turn", record.sessionId, record.timestamp, record.provider, record.model,
      record.input, record.output, record.cacheRead, record.cacheWrite]);
}

export async function appendUsage(record: TokenUsageRecord): Promise<boolean> {
  return withLedgerLock(async () => {
    const path = ledgerPath(localDate(record.timestamp));
    const identity = usageIdentity(record);
    if (identity) {
      // Aggregate-only child receipts have no original timestamp. Their run ID
      // remains unique even if a long-lived session is reconciled weeks later.
      const paths = record.model === "unknown-subagent"
        ? (await readdir(usageDirectory())).filter((name) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
          .map((name) => join(usageDirectory(), name))
        : [path];
      for (const file of paths) {
        let content = "";
        try { content = await readFile(file, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (content.split("\n").some((line) => {
          try { return usageIdentity(JSON.parse(line) as TokenUsageRecord) === identity; }
          catch { return false; }
        })) return false;
      }
    }
    await appendFile(path, JSON.stringify(record) + "\n", { mode: 0o600 });
    return true;
  });
}

export async function readDailyUsage(day = localDate(Date.now()), accountId?: string | null): Promise<TokenTotals> {
  return withLedgerLock(async () => {
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
        if (record.provider === "openai-codex" && accountId !== undefined
          && (accountId === null ? record.accountId !== undefined : record.accountId !== accountId)) return totals;
        return accumulate(totals, record);
      } catch { return totals; }
    }, emptyTotals());
  });
}
