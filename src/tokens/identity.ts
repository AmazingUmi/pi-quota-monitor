import type { TokenUsageRecord } from "../types.js";

/** Stable identity for a child receipt or an assistant turn, independent of its ledger file. */
export function usageIdentity(record: TokenUsageRecord): string | undefined {
  if (typeof record.sessionId !== "string" || !record.sessionId) return undefined;
  // Aggregate-only CLI receipts have no message timestamp; runId is their stable identity.
  return record.model === "unknown-subagent" && typeof record.runId === "string" && record.runId
    ? JSON.stringify(["run", record.sessionId, record.runId])
    : JSON.stringify(["turn", record.sessionId, record.timestamp, record.provider, record.model,
      record.input, record.output, record.cacheRead, record.cacheWrite]);
}
