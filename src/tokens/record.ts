import { accountKey, isAccountProvider, stableAccountId } from "../account-identity.js";
import type { TokenUsageRecord } from "../types.js";
import { ledgerDateMatches } from "./ledger-date.js";

/** One validation rule for aggregation, daily totals and history operations; legacy identity fields remain optional. */
export function validUsageRecord(value: unknown, day: string): value is TokenUsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<TokenUsageRecord>;
  return typeof record.timestamp === "number" && ledgerDateMatches(record.timestamp, day)
    && typeof record.provider === "string" && record.provider.length > 0
    && typeof record.model === "string" && record.model.length > 0
    && (record.accountId === undefined || stableAccountId(record.accountId) !== undefined)
    && (record.authType === undefined || ["oauth", "api-key", "unknown"].includes(record.authType))
    && (record.accountKey === undefined || (isAccountProvider(record.provider) && !!record.accountId && record.accountKey === accountKey(record.provider, record.accountId)))
    && (["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"] as const)
      .every((field) => typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] >= 0);
}
