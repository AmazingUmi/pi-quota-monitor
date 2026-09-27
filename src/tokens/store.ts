import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { usageDirectory } from "../config.js";
import type { TokenTotals, TokenUsageRecord } from "../types.js";
import { accumulate, emptyTotals } from "./collector.js";
import { withLedgerLock } from "../history.js";
import { ledgerDateMatches } from "./ledger-date.js";

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
    const midnight = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(midnight)) return emptyTotals();
    let totals = emptyTotals();
    // The filename is the writer's local date. A reader in another time zone
    // can see that same timestamp up to two civil days away from the filename.
    for (let offset = -2; offset <= 2; offset++) {
      const fileDay = new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10);
      let content: string;
      try { content = await readFile(ledgerPath(fileDay), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as TokenUsageRecord;
          if (typeof record.timestamp !== "number" || !ledgerDateMatches(record.timestamp, fileDay) || localDate(record.timestamp) !== day
            || ![record.input, record.output, record.reasoning, record.cacheRead, record.cacheWrite, record.totalTokens].every(Number.isFinite)) continue;
          if (record.provider === "openai-codex" && accountId !== undefined
            && (accountId === null ? record.accountId !== undefined : record.accountId !== accountId)) continue;
          totals = accumulate(totals, record);
        } catch { /* Ignore malformed rows as before. */ }
      }
    }
    return totals;
  });
}
