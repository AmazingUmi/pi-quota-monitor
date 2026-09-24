import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TokenTotals, TokenUsageRecord } from "../types.js";
import { estimateRecordCost, PRICE_DATE } from "./pricing.js";

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function accumulate(totals: TokenTotals, record: TokenTotals): TokenTotals {
  return {
    input: totals.input + record.input,
    output: totals.output + record.output,
    reasoning: totals.reasoning + record.reasoning,
    cacheRead: totals.cacheRead + record.cacheRead,
    cacheWrite: totals.cacheWrite + record.cacheWrite,
    totalTokens: totals.totalTokens + record.totalTokens,
  };
}

export function tokenRecord(message: AssistantMessage): TokenUsageRecord | undefined {
  const usage = message.usage;
  if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(Number.isFinite)) return undefined;
  // Reasoning is a subset of output; never add it again to totalTokens.
  const record: TokenUsageRecord = {
    timestamp: message.timestamp,
    provider: message.provider,
    model: message.model,
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning ?? 0,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
  const cost = estimateRecordCost(record);
  return { ...record, pricingAsOf: PRICE_DATE, ...(cost !== undefined ? { estimatedCostUsd: cost } : {}) };
}
