import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexQuota, queryCodexQuota } from "../src/providers/codex.js";
import { parseAntigravityQuota, parseNativeAntigravityQuota, queryAntigravityQuota } from "../src/providers/antigravity.js";
import { emptyTotals, tokenRecord } from "../src/tokens/collector.js";
import { formatStatus, groupWindow } from "../src/statusline.js";
import { DEFAULT_CONFIG, configPath, loadConfig, normalizeConfig, saveConfig } from "../src/config.js";

const now = Date.parse("2026-06-01T12:00:00Z");

describe("Codex", () => {
  it("parses five-hour and weekly windows, used percent and epoch-second resets", () => {
    const result = parseCodexQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1780333200 },
        secondary_window: { used_percent: 39, limit_window_seconds: 604800, reset_at: 1780506000 },
      },
    }, now);
    expect(result.fiveHour?.remainingPercent).toBe(73);
    expect(result.weekly?.remainingPercent).toBe(61);
    expect(result.fiveHour?.resetAt).toBe(1780333200000);
  });

  it("displays prolite as pro and applies Pro weekly-window rules", () => {
    const result = parseCodexQuota({ plan_type: "ProLite", rate_limit: {
      primary_window: { used_percent: 87 }, secondary_window: null,
    } }, now);
    expect(result.plan).toBe("pro");
    expect(result.weekly?.remainingPercent).toBe(13);
    expect(result.fiveHour).toBeUndefined();
  });

  it("classifies a Pro weekly-only primary without inventing a five-hour quota", () => {
    const result = parseCodexQuota({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 87, limit_window_seconds: 604800, reset_at: 1780506000 },
      secondary_window: null,
    } }, now);
    expect(result.fiveHour).toBeUndefined();
    expect(result.weekly?.remainingPercent).toBe(13);
    expect(formatStatus({ value: result }, {}, emptyTotals(), false)).toContain("OAI -/13%");
  });

  it("treats a single Pro window without duration as weekly, but does not do so for Plus", () => {
    const rate_limit = { primary_window: { used_percent: 87 }, secondary_window: null };
    const pro = parseCodexQuota({ plan_type: "pro", rate_limit }, now);
    const plus = parseCodexQuota({ plan_type: "plus", rate_limit }, now);
    expect(pro.fiveHour).toBeUndefined();
    expect(pro.weekly?.remainingPercent).toBe(13);
    expect(formatStatus({ value: pro }, {}, emptyTotals(), false)).toContain("OAI -/13%");
    expect(plus.weekly).toBeUndefined();
    expect(formatStatus({ value: plus }, {}, emptyTotals(), false)).toContain("OAI -/-");
  });

  it("replaces only missing OAI values with dashes, preserving known weekly quota", () => {
    const result = parseCodexQuota({ plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 89, limit_window_seconds: 604800 }, secondary_window: null,
    } }, now);
    expect(result.weekly?.remainingPercent).toBe(11);
    expect(formatStatus({ value: result }, {}, emptyTotals(), false)).toContain("OAI -/11%");
    const unknown = parseCodexQuota({ rate_limit: { primary_window: { used_percent: 89, limit_window_seconds: 604800 } } }, now);
    expect(formatStatus({ value: unknown }, {}, emptyTotals(), false)).toContain("OAI -/11%");
    expect(formatStatus({}, {}, emptyTotals(), false)).toContain("OAI -/-");
  });

  it("classifies windows by duration even when their positions are reversed", () => {
    const result = parseCodexQuota({ rate_limit: {
      primary_window: { used_percent: 87, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18000 },
    } }, now);
    expect(result.fiveHour?.remainingPercent).toBe(80);
    expect(result.weekly?.remainingPercent).toBe(13);
  });

  it("does not label an unknown-duration window as five-hour or weekly", () => {
    const result = parseCodexQuota({ rate_limit: {
      primary_window: { used_percent: 87 }, secondary_window: null,
    } }, now);
    expect(result.fiveHour).toBeUndefined();
    expect(result.weekly).toBeUndefined();
  });

  it("sends credentials only to the official origin and rejects redirects", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 50 } },
    }), { headers: { "Content-Type": "application/json" } }));
    try {
      await queryCodexQuota({ apiKey: "secret", headers: { "x-other-secret": "must-not-leak" } }, new AbortController().signal, 1000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
      const init = fetcher.mock.calls[0]?.[1];
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-other-secret")).toBeNull();
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      await expect(queryCodexQuota({ apiKey: "secret", baseUrl: "https://proxy.example.com" }, new AbortController().signal, 1000)).rejects.toThrow("custom endpoint");
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { fetcher.mockRestore(); }
  });
});

describe("Antigravity", () => {
  it("parses agy's native /usage result with snake-case buckets and reset times", () => {
    const result = parseNativeAntigravityQuota(JSON.stringify({ event: "result", result: {
      status: "SUCCESS", command: { name: "usage", data: { groups: [
        { name: "Gemini", buckets: [
          { id: "5h", name: "5h limit remaining", remaining_fraction: 0.82, reset_time: "2026-06-01T13:00:00Z" },
          { id: "weekly", name: "Weekly limit remaining", remaining_fraction: 0.6 },
        ] },
        { name: "Claude/GPT", buckets: [{ id: "5h", name: "5h", remaining_fraction: 0.67 }] },
      ] } },
    } }), now);
    expect(groupWindow(result, "gemini")?.remainingPercent).toBe(60);
    expect(result.groups[0]?.windows[0]?.resetAt).toBe(Date.parse("2026-06-01T13:00:00Z"));
    expect(groupWindow(result, "shared")?.remainingPercent).toBe(67);
    expect(() => parseNativeAntigravityQuota(JSON.stringify({ status: "FAILED", error: "sensitive upstream text" }))).toThrow("agy usage command failed");
    expect(() => parseNativeAntigravityQuota(JSON.stringify({ command: { name: "usage", data: { groups: [] } } }))).toThrow("no quota groups");
  });
  it("prefers paid tier and falls back to per-model percentages if aggregate summary is unavailable", () => {
    const result = parseAntigravityQuota(
      { currentTier: { name: "Free" }, paidTier: { name: "Google AI Pro" } },
      undefined,
      { models: {
        "gemini-3-flash": { quotaInfo: { remainingFraction: 0.84, resetTime: "2026-06-01T13:00:00Z" } },
        "claude-sonnet": { quotaInfo: { remainingFraction: 0.67 } },
        chat_internal: { quotaInfo: { remainingFraction: 0.01 } },
      } }, now, "Summary unavailable",
    );
    expect(result.plan).toBe("Google AI Pro");
    expect(groupWindow(result, "gemini")?.remainingPercent).toBe(84);
    expect(groupWindow(result, "shared")?.remainingPercent).toBe(67);
    expect(result.models).toHaveLength(2);
    expect(result.summaryError).toBe("Summary unavailable");
    expect(formatStatus({}, { value: result }, emptyTotals(), false)).toContain("AGY -/-");
  });

  it("uses aggregate groups when present and keeps the restrictive bucket", () => {
    const result = parseAntigravityQuota(undefined, { groups: [
      { displayName: "Gemini", buckets: [
        { displayName: "5h", remainingFraction: 0.8, resetTime: "2026-06-01T13:00:00Z" },
        { displayName: "Weekly", remainingFraction: 0.6 },
      ] },
      { displayName: "Claude/GPT shared", buckets: [{ displayName: "5h", remainingFraction: 0.67 }] },
    ] }, undefined, now);
    expect(groupWindow(result, "gemini")?.remainingPercent).toBe(60);
    expect(groupWindow(result, "shared")?.remainingPercent).toBe(67);
    expect(formatStatus({}, { value: result }, emptyTotals(), false)).toContain("AGY 80%/60%");
  });

  it("replaces only missing AGY values with dashes, preserving known percentages", () => {
    const weeklyOnly = parseAntigravityQuota(undefined, { groups: [
      { displayName: "Gemini", buckets: [{ displayName: "Weekly", remainingFraction: 0.11 }] },
    ] }, undefined, now);
    expect(formatStatus({}, { value: weeklyOnly }, emptyTotals(), false)).toContain("AGY -/11%");
    const fiveHourOnly = parseAntigravityQuota(undefined, { groups: [
      { displayName: "Gemini", buckets: [{ displayName: "5h", remainingFraction: 0.84 }] },
    ] }, undefined, now);
    expect(formatStatus({}, { value: fiveHourOnly }, emptyTotals(), false)).toContain("AGY 84%/-");
    expect(formatStatus({}, {}, emptyTotals(), false)).toContain("AGY -/-");
  });

  it("shows Gemini 5h/weekly quotas and the 5h reset, without the Claude/GPT value", () => {
    const result = parseNativeAntigravityQuota(JSON.stringify({ command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [
        { name: "Weekly Limit Remaining", remaining_fraction: 0.8291 },
        { name: "Five Hour Limit Remaining", remaining_fraction: 0.9538, reset_time: new Date(now + 137 * 60_000).toISOString() },
      ] },
      { name: "Claude and GPT models", buckets: [{ name: "Weekly Limit Remaining", remaining_fraction: 1 }] },
    ] } } }), now);
    expect(formatStatus({}, { value: result }, emptyTotals(), true, now)).toContain("AGY 95%/83% ↻2h17m");
    expect(formatStatus({}, { value: result }, emptyTotals(), false, now)).toContain("AGY 95%/83% | ");
  });

  it("uses only official Cloud Code Assist endpoints with redirect protection", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith(":fetchAvailableModels")) return new Response(JSON.stringify({ models: { "gemini-test": { quotaInfo: { remainingFraction: 0.84 } } } }));
      if (path.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify({ groups: [] }));
      return new Response(JSON.stringify({ paidTier: { name: "Pro" } }));
    });
    try {
      const result = await queryAntigravityQuota(JSON.stringify({ token: "secret", projectId: "project" }), new AbortController().signal, 1000);
      expect(result.plan).toBe("Pro");
      expect(fetcher).toHaveBeenCalledTimes(3);
      for (const [url, init] of fetcher.mock.calls) {
        expect(new URL(String(url)).origin).toBe("https://daily-cloudcode-pa.googleapis.com");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      }
    } finally { fetcher.mockRestore(); }
  });

  it("rejects malformed credentials without network calls", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      await expect(queryAntigravityQuota("bad", new AbortController().signal, 1000)).rejects.toThrow("Invalid Antigravity");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
});

it("counts reasoning as part of output and preserves last success in the status", () => {
  const record = tokenRecord({
    role: "assistant", provider: "antigravity", model: "gemini-test", api: "antigravity-api",
    timestamp: now, content: [], stopReason: "stop",
    usage: { input: 284000, output: 37000, reasoning: 12000, cacheRead: 100, cacheWrite: 200, totalTokens: 321300,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  expect(record?.reasoning).toBe(12000);
  expect(record?.totalTokens).toBe(321300);
  expect(formatStatus({ value: { capturedAt: now, fiveHour: { label: "5h", remainingPercent: 73 }, weekly: { label: "weekly", remainingPercent: 61 } }, error: "Query failed" }, {}, record!, false))
    .toBe("OAI 73%/61% | AGY -/- | ↑284k ↓37k");
});

it("bounds user-configurable refresh interval", () => {
  expect(normalizeConfig({ refreshIntervalSeconds: 60 }).refreshIntervalSeconds).toBe(60);
  expect(normalizeConfig({ refreshIntervalSeconds: 10 }).refreshIntervalSeconds).toBe(180);
  expect(normalizeConfig({ refreshIntervalSeconds: 3601 }).refreshIntervalSeconds).toBe(180);
});

it("defaults missing statusbar options on for old configs and validates explicit booleans", () => {
  expect(normalizeConfig({}).showOaiInStatusbar).toBe(true);
  expect(normalizeConfig({}).showAgyInStatusbar).toBe(true);
  expect(normalizeConfig({ showOaiInStatusbar: false, showAgyInStatusbar: "false" })).toMatchObject({
    showOaiInStatusbar: false, showAgyInStatusbar: true,
  });
});

it("persists statusbar settings in config and reloads them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-quota-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
    const changed = { ...DEFAULT_CONFIG, dashboardPort: 39876, showOaiInStatusbar: false, showAgyInStatusbar: true };
    await saveConfig(changed);
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual(changed);
    expect(await loadConfig()).toEqual(changed);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("supports all RPC statusbar provider combinations without empty separators", () => {
  const codex = { value: { capturedAt: now, fiveHour: { label: "5h", remainingPercent: 73 }, weekly: { label: "weekly", remainingPercent: 61 } } };
  const agy = { value: { capturedAt: now, groups: [
    { name: "Gemini", windows: [{ label: "5h", remainingPercent: 84 }, { label: "Weekly", remainingPercent: 67 }] },
  ], models: [] } };
  const totals = emptyTotals();
  expect(formatStatus(codex, agy, totals, false, now, { showOai: true, showAgy: true }))
    .toBe("OAI 73%/61% | AGY 84%/67% | ↑0 ↓0");
  expect(formatStatus(codex, agy, totals, false, now, { showOai: true, showAgy: false }))
    .toBe("OAI 73%/61% | ↑0 ↓0");
  expect(formatStatus(codex, agy, totals, false, now, { showOai: false, showAgy: true }))
    .toBe("AGY 84%/67% | ↑0 ↓0");
  expect(formatStatus(codex, agy, totals, false, now, { showOai: false, showAgy: false }))
    .toBe("↑0 ↓0");
});
