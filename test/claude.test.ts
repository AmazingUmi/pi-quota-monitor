import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeIdentity, parseClaudeQuota, queryClaudeQuota } from "../src/providers/claude.js";
import { QuotaReadings } from "../src/quota-readings.js";
import { quotaAmountEstimates } from "../src/quota-estimate.js";
import { appendUsage } from "../src/tokens/store.js";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { formatStatus } from "../src/statusline.js";
import { emptyTotals } from "../src/tokens/collector.js";

const now = Date.now();
const payload = { five_hour: { utilization: 25, resets_at: new Date(now + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: 40, resets_at: new Date(now + 2 * 86_400_000).toISOString() } };
const profile = { account: { uuid: "account-one", email: "never-serialize@example.com" }, organization: { uuid: "org-one" } };
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("parses only bounded quota windows and stable opaque account identity", () => {
  const quota = parseClaudeQuota(payload, now);
  expect(quota.fiveHour?.remainingPercent).toBe(75);
  expect(quota.weekly?.remainingPercent).toBe(60);
  expect(quota.fiveHour?.resetAt).toBeGreaterThan(now);
  expect(() => parseClaudeQuota({ five_hour: { utilization: 101 }, seven_day: null })).toThrow();
  const id = parseClaudeIdentity(profile)!;
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  expect(id).not.toContain("account-one");
  expect(parseClaudeIdentity({ ...profile, organization: {} })).toBeUndefined();
  expect(parseClaudeIdentity({ ...profile, account: { uuid: "account-two" } })).not.toBe(id);
});

it("sends Pi OAuth only to fixed Anthropic endpoints, without exposing profile data", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).endsWith("/profile") ? profile : payload)));
  const result = await queryClaudeQuota("secret", new AbortController().signal, 1000);
  expect(result.accountId).toBe(parseClaudeIdentity(profile));
  expect(result.quota.weekly?.remainingPercent).toBe(60);
  expect(JSON.stringify(result)).not.toContain("never-serialize");
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://api.anthropic.com/api/oauth/usage", "https://api.anthropic.com/api/oauth/profile",
  ]);
  for (const [, init] of fetcher.mock.calls) {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe("oauth-2025-04-20");
  }
  fetcher.mockImplementation(async (url) => String(url).endsWith("/profile")
    ? new Response("denied", { status: 403 }) : new Response(JSON.stringify(payload)));
  const unknown = await queryClaudeQuota("secret", new AbortController().signal, 1000);
  expect(unknown.quota.fiveHour?.remainingPercent).toBe(75);
  expect(unknown.accountId).toBeUndefined();
});

it("isolates Claude amount calibration by identity and excludes unattributed usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-quota-"));
  directories.push(dir);
  const before = now - 120_000;
  const after = now - 60_000;
  const reading = (capturedAt: number, remainingPercent: number) => ({ capturedAt,
    fiveHour: { label: "5h", remainingPercent, resetAt: now + 2 * 3_600_000, windowMinutes: 300 },
    weekly: { label: "weekly", remainingPercent, resetAt: now + 2 * 86_400_000, windowMinutes: 10080 } });
  const old = reading(before, 80), latest = reading(after, 70);
  const entry = (accountId: string | undefined, timestamp: number) => ({ timestamp, provider: "anthropic", model: "claude-sonnet-4-6",
    input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
    estimatedCostUsd: 1, ...(accountId ? { accountId } : {}) });
  const { configDirectory } = await import("../src/config.js");
  // Append via the normal ledger, but keep all test writes under a temporary Pi dir.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await appendUsage(entry("identity-a", before + 1000));
    await appendUsage(entry("identity-b", before + 2000));
    const aggregator = new UsageAggregator();
    await aggregator.refresh();
    const estimates = quotaAmountEstimates(aggregator, {}, {}, [], [], { value: latest }, [old], "identity-a");
    expect(estimates.claude.fiveHour).toMatchObject({ observedCostUsd: 1, estimatedPeriodUsd: 10, estimatedRemainingUsd: 7, attribution: "correlated" });
    expect(quotaAmountEstimates(aggregator, {}, {}, [], [], { value: latest }, [old]).claude.fiveHour.estimatedPeriodUsd).toBeUndefined();
    await appendUsage(entry(undefined, before + 3000));
    await aggregator.refresh();
    expect(quotaAmountEstimates(aggregator, {}, {}, [], [], { value: latest }, [old], "identity-a").claude.fiveHour.estimatedPeriodUsd).toBeUndefined();
    const store = new QuotaReadings("claude", "identity-a", configDirectory());
    await store.append(latest);
    expect(await store.load()).toHaveLength(1);
    expect(await new QuotaReadings("claude", "identity-b", configDirectory()).load()).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

it("renders CLA independently and honors the third visibility switch", () => {
  const claude = { value: parseClaudeQuota(payload, now) };
  expect(formatStatus({}, {}, emptyTotals(), false, now, {}, claude)).toContain("CLA 75%/60%");
  expect(formatStatus({}, {}, emptyTotals(), false, now, { showOai: false, showAgy: false, showClaude: false }, claude)).toBe("↑0 ↓0");
});
