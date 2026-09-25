export interface QuotaWindow {
  label: string;
  remainingPercent: number;
  resetAt?: number;
  windowMinutes?: number;
}

export interface CodexQuota {
  capturedAt: number;
  plan?: string;
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
}

export interface AntigravityQuotaGroup {
  name: string;
  windows: QuotaWindow[];
}

export interface AntigravityModelQuota {
  modelId: string;
  displayName?: string;
  remainingPercent?: number;
  resetAt?: number;
}

export interface AntigravityQuota {
  capturedAt: number;
  plan?: string;
  groups: AntigravityQuotaGroup[];
  models: AntigravityModelQuota[];
  summaryError?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface TokenUsageRecord extends TokenTotals {
  timestamp: number;
  provider: string;
  model: string;
  accountId?: string;
  source?: "pi-message" | "pi-subagents";
  sessionId?: string;
  runId?: string;
  /** Public API equivalent cost frozen when this record was collected, not subscription billing. */
  estimatedCostUsd?: number;
  pricingAsOf?: string;
}

export interface ProviderCache<T> {
  value?: T;
  lastAttemptAt?: number;
  error?: string;
  storageError?: string;
  restored?: boolean;
}

export interface QuotaAmountEstimate {
  note: string;
  observedCostUsd?: number;
  observedTokens?: number;
  /** Bounds of included adjacent sample intervals; gaps within the bounds are excluded. */
  sampleStartAt?: number;
  sampleEndAt?: number;
  sampleIntervals?: number;
  /** Count of observed quota declines represented by those intervals. */
  quotaChanges?: number;
  /** Local tokens since the last weekly decline, awaiting a matching quota observation. */
  pendingTokens?: number;
  /** Sum of included intervals' percentage-point drops, not the whole cycle's used percentage. */
  usedPercent?: number;
  /** Independently verified Pi-attributed percentage-point consumption, if supplied. */
  piAttributedPercent?: number;
  /** Denominator used for the quote; correlated means only coincident Pi activity, not proven attribution. */
  calibrationPercent?: number;
  attribution?: "verified" | "correlated";
  excludedIntervals?: number;
  contaminated?: boolean;
  estimatedPeriodUsd?: number;
  estimatedRemainingUsd?: number;
  unpricedRecords?: number;
  ledgerStale?: boolean;
}

export interface QuotaAmountEstimates {
  codex: { fiveHour: QuotaAmountEstimate; weekly: QuotaAmountEstimate };
  antigravity: { groups: Array<{ name: string; windows: Array<QuotaAmountEstimate | null> }> };
}

export interface MonitorConfig {
  dashboardPort: number;
  refreshIntervalSeconds: number;
  staleAfterSeconds: number;
  requestTimeoutSeconds: number;
  showReset: boolean;
  showOaiInStatusbar: boolean;
  showAgyInStatusbar: boolean;
}
