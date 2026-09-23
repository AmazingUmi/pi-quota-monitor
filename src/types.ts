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
}

export interface ProviderCache<T> {
  value?: T;
  lastAttemptAt?: number;
  error?: string;
}

export interface MonitorConfig {
  refreshIntervalSeconds: number;
  staleAfterSeconds: number;
  requestTimeoutSeconds: number;
  showReset: boolean;
}
