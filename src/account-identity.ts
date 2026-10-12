import { createHash } from "node:crypto";
import type { TokenUsageRecord } from "./types.js";

export const ACCOUNT_PROVIDERS = ["openai-codex", "anthropic", "xai"] as const;
export type AccountProvider = typeof ACCOUNT_PROVIDERS[number];
export const PROVIDER_NAMES: Record<AccountProvider, string> = { "openai-codex": "Codex", anthropic: "Claude", xai: "Grok" };
export function isAccountProvider(value: unknown): value is AccountProvider {
  return typeof value === "string" && ACCOUNT_PROVIDERS.includes(value as AccountProvider);
}
export function stableAccountId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
/** Provider-qualified, opaque identity. Emails, notes and rotating tokens are never keys. */
export function accountKey(provider: AccountProvider, accountId: string): string {
  return createHash("sha256").update(JSON.stringify([provider, accountId])).digest("hex");
}
export function accountViewId(provider: AccountProvider, accountId: string): string {
  return `account:${accountKey(provider, accountId)}`;
}
export function jwtClaims(access: string): Record<string, unknown> | undefined {
  const parts = access.split(".");
  if (parts.length !== 3 || parts[1].length > 32_768) return;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}
export function displayText(value: unknown, max = 120): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
}
export function accountEmail(value: unknown): string | undefined {
  const email = displayText(value, 254);
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export type UsageScope = { type: "all" } | { type: "provider"; provider: string }
  | { type: "account"; provider: AccountProvider; accountId: string }
  | { type: "other" } | { type: "unassigned"; provider?: AccountProvider };
/** Compatibility: old string filters now mean a strict Codex account, never shared providers. */
export function usageScope(value?: UsageScope | string | null): UsageScope {
  return typeof value === "string" ? { type: "account", provider: "openai-codex", accountId: value }
    : value === null ? { type: "unassigned", provider: "openai-codex" } : value ?? { type: "all" };
}
export function recordAccountId(record: Pick<TokenUsageRecord, "provider" | "accountId" | "authType">): string | undefined {
  return isAccountProvider(record.provider) && (record.authType === undefined || record.authType === "oauth") ? stableAccountId(record.accountId) : undefined;
}
export function matchesUsage(record: Pick<TokenUsageRecord, "provider" | "accountId" | "authType">, scope: UsageScope): boolean {
  const id = recordAccountId(record);
  switch (scope.type) {
    case "all": return true;
    case "provider": return record.provider === scope.provider;
    case "account": return record.provider === scope.provider && id === scope.accountId;
    case "other": return record.provider !== "subagent-unattributed" && (!isAccountProvider(record.provider) || record.authType === "api-key");
    case "unassigned": return (record.provider === "subagent-unattributed" && !scope.provider)
      || (isAccountProvider(record.provider) && record.authType !== "api-key" && !id && (!scope.provider || record.provider === scope.provider));
  }
}
