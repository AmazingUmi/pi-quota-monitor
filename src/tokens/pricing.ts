import type { TokenUsageRecord } from "../types.js";

/** USD per million tokens, public global on-demand/effective rates, checked 2026-09-25. */
export interface Rates { input: number; output: number; cacheRead: number; cacheWrite?: number }
export interface PriceRow {
  provider: "openai-codex" | "antigravity" | "google-vertex";
  model: string;
  rates: Rates;
  source: string;
  effectiveFrom?: number;
  /** Full-request threshold; the ledger cannot capture provider-specific modalities or storage time. */
  longContext?: { threshold: number; rates: Rates };
}

const OPENAI = "https://developers.openai.com/api/docs/models/";
const GEMINI = "https://ai.google.dev/gemini-api/docs/pricing";
const VERTEX = "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing";
const CLAUDE = "https://platform.claude.com/docs/en/about-claude/pricing";
const openai = (model: string, input: number, output: number, cacheRead: number, cacheWrite?: number): PriceRow => ({
  provider: "openai-codex", model, rates: { input, output, cacheRead, ...(cacheWrite === undefined ? {} : { cacheWrite }) },
  source: `${OPENAI}${model}`,
  ...(model.startsWith("gpt-6-") || model === "gpt-5.4" ? { longContext: { threshold: 272_000, rates: {
    input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2,
    ...(cacheWrite === undefined ? {} : { cacheWrite: cacheWrite * 2 }),
  } } } : {}),
});
const gemini = (model: string, input: number, output: number, cacheRead: number, high?: [number, number, number]): PriceRow => ({
  provider: "antigravity", model, rates: { input, output, cacheRead }, source: GEMINI,
  ...(high ? { longContext: { threshold: 200_000, rates: { input: high[0], output: high[1], cacheRead: high[2] } } } : {}),
});
const claude = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number): PriceRow => ({
  provider: "antigravity", model, rates: { input, output, cacheRead, cacheWrite }, source: CLAUDE,
});

export const PRICE_DATE = "2026-09-25";
export const PRICE_TABLE: readonly PriceRow[] = [
  openai("gpt-6-sol", 2, 10, 0.2, 2.5),
  openai("gpt-6-luna", 0.1, 0.5, 0.01, 0.125),
  openai("gpt-6-astra", 10, 50, 1, 12.5),
  openai("gpt-5.4", 2.5, 15, 0.25),
  openai("gpt-5.4-mini", 0.75, 4.5, 0.075),
  openai("gpt-5.3-codex", 1.75, 14, 0.175),
  gemini("gemini-3.8-flash", 0.75, 3.75, 0.075),
  // Vertex global introductory effective rates through 2026-12-31, followed by
  // published 2027 rates. Region, batch, grounding and cache storage are unknown.
  { provider: "google-vertex", model: "gemini-3.8-flash", rates: { input: 0.75, output: 3.75, cacheRead: 0.075 }, source: VERTEX },
  { provider: "google-vertex", model: "gemini-3.8-flash", effectiveFrom: Date.UTC(2027, 0, 1),
    rates: { input: 1.5, output: 7.5, cacheRead: 0.15 }, source: VERTEX },
  gemini("gemini-3.1-pro-preview", 2, 12, 0.2, [4, 18, 0.4]),
  gemini("gemini-3-flash-preview", 0.5, 3, 0.05),
  gemini("gemini-3.1-flash-lite", 0.25, 1.5, 0.025),
  gemini("gemini-2.5-pro", 1.25, 10, 0.125, [2.5, 15, 0.25]),
  gemini("gemini-2.5-flash", 0.3, 2.5, 0.03),
  claude("claude-opus-5-5", 4, 20, 0.2, 5),
  claude("claude-opus-4-6", 5, 25, 0.5, 6.25),
  claude("claude-sonnet-5", 2, 10, 0.2, 2.5),
  claude("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
  claude("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
  claude("claude-haiku-4-5", 1, 5, 0.1, 1.25),
];

function priceFor(provider: string, model: string, timestamp: number): PriceRow | undefined {
  const normalized = model.toLowerCase();
  return [...PRICE_TABLE].reverse().find((row) => row.provider === provider && (row.effectiveFrom === undefined || timestamp >= row.effectiveFrom)
    && (normalized === row.model
    || (row.provider === "antigravity" && row.model === "gemini-3.8-flash" && /^gemini-3\.8-flash-(?:low|medium|high)$/.test(normalized))
    || (row.model === "gemini-3.1-pro-preview" && normalized === "gemini-3.1-pro-preview-customtools")
    || (row.model.startsWith("claude-") && new RegExp(`^${row.model}(?:-thinking|-\\d{8})?$`).test(normalized))));
}

/** No speculative fallback for unknown IDs, unsupported cache-write rates or modalities. */
export function estimateRecordCost(record: TokenUsageRecord): number | undefined {
  // New ledger entries retain their recorded amount even when the catalog later changes.
  if (record.estimatedCostUsd !== undefined) return Number.isFinite(record.estimatedCostUsd) && record.estimatedCostUsd >= 0 ? record.estimatedCostUsd : undefined;
  // Preserve previously collected unknown models. Backfill only verified 3.8 Flash
  // IDs; older google-vertex records could not be priced before this addition.
  if (record.pricingAsOf !== undefined && !(record.provider === "antigravity" &&
    /^gemini-3\.8-flash(?:-(?:low|medium|high))?$/i.test(record.model))
    && !(record.provider === "google-vertex" && /^gemini-3\.8-flash$/i.test(record.model))) return undefined;
  const price = priceFor(record.provider, record.model, record.timestamp);
  if (!price) return undefined;
  const prompt = record.input + record.cacheRead + record.cacheWrite;
  const rates = price.longContext && prompt > price.longContext.threshold ? price.longContext.rates : price.rates;
  if (record.cacheWrite > 0 && rates.cacheWrite === undefined) return undefined;
  return (record.input * rates.input + record.output * rates.output
    + record.cacheRead * rates.cacheRead + record.cacheWrite * (rates.cacheWrite ?? 0)) / 1_000_000;
}
