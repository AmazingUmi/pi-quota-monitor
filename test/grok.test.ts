import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokAccountId, parseGrokPlan, parseGrokQuota, queryGrokQuota } from "../src/providers/grok.js";
import { QuotaReadings } from "../src/quota-readings.js";
import { formatStatus } from "../src/statusline.js";
import { emptyTotals } from "../src/tokens/collector.js";

const now = Date.parse("2026-10-11T12:00:00Z");
const start = "2026-10-09T15:48:17.640Z";
const end = "2026-10-16T15:48:17.640Z";
const billing = {
  config: {
    creditUsagePercent: 3,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
    billingPeriodStart: start,
    billingPeriodEnd: end,
    productUsage: [{ product: "GrokBuild", usagePercent: 1 }],
    prepaidBalance: { val: 0 },
  },
};
const settings = { subscription_tier_display: "SuperGrok", email: "never-serialize@example.com" };
function token(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${part}.sig`;
}
const access = token({ sub: "user-one", team_id: "team-one" });
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("parses the shared credit window without copying product or wallet fields", () => {
  const quota = parseGrokQuota(billing, parseGrokPlan(settings), now);
  expect(quota.plan).toBe("SuperGrok");
  expect(quota.credit).toMatchObject({ label: "weekly", remainingPercent: 97, windowMinutes: 10080 });
  expect(quota.credit?.resetAt).toBe(Date.parse(end));
  expect(JSON.stringify(quota)).not.toContain("GrokBuild");
  expect(JSON.stringify(quota)).not.toContain("prepaid");
  expect(parseGrokQuota({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-11-09T00:00:00Z" } } }, undefined, now).credit)
    .toMatchObject({ label: "monthly", remainingPercent: 100 });
  expect(() => parseGrokQuota({ config: { creditUsagePercent: 101 } })).toThrow();
  expect(() => parseGrokQuota({ config: {} })).toThrow();
});

it("sends only the Pi OAuth bearer to the fixed Grok billing host", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).endsWith("/settings") ? settings : billing)));
  const result = await queryGrokQuota(access, new AbortController().signal, 1000);
  expect(result.accountId).toBe(grokAccountId(access));
  expect(result.accountId).toMatch(/^[0-9a-f]{64}$/);
  expect(result.accountId).not.toContain("user-one");
  expect(result.quota.credit?.remainingPercent).toBe(97);
  expect(JSON.stringify(result)).not.toContain("never-serialize");
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    "https://cli-chat-proxy.grok.com/v1/settings",
  ]);
  for (const [, init] of fetcher.mock.calls) {
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${access}`);
    expect(headers.get("x-xai-token-auth")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization"]);
  }
  fetcher.mockImplementation(async (url) => String(url).endsWith("/settings")
    ? new Response("denied", { status: 403 }) : new Response(JSON.stringify(billing)));
  const withoutPlan = await queryGrokQuota(access, new AbortController().signal, 1000);
  expect(withoutPlan.quota.plan).toBeUndefined();
  expect(withoutPlan.quota.credit?.remainingPercent).toBe(97);
  await expect(queryGrokQuota("not a token", new AbortController().signal, 1000)).rejects.toThrow(/unavailable/);
});

it("isolates stored readings by hashed account and drops unknown fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-quota-"));
  directories.push(dir);
  const id = grokAccountId(access)!;
  const other = createHash("sha256").update(JSON.stringify(["user-two", "team-one"])).digest("hex");
  const store = new QuotaReadings("grok", id, dir);
  await store.append(parseGrokQuota(billing, "SuperGrok", now));
  expect(await store.load(now + 1000)).toHaveLength(1);
  expect(await new QuotaReadings("grok", other, dir).load(now + 1000)).toHaveLength(0);
  expect(JSON.stringify(await store.load(now + 1000))).not.toContain("GrokBuild");
});

it("renders one GRK credit value and honors its visibility switch", () => {
  const grok = { value: parseGrokQuota(billing, "SuperGrok", now) };
  expect(formatStatus({}, {}, emptyTotals(), false, now, {}, undefined, grok)).toContain("GRK 97%");
  expect(formatStatus({}, {}, emptyTotals(), true, now, {}, undefined, grok)).toContain("GRK 97% ↻");
  expect(formatStatus({}, {}, emptyTotals(), false, now, { showOai: false, showAgy: false, showGrok: false }, undefined, grok)).toBe("↑0 ↓0");
  expect(formatStatus({}, {}, emptyTotals(), false, now)).not.toContain("GRK");
});
