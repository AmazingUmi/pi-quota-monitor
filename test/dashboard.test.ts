import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { QuotaDashboard, type DashboardState } from "../src/dashboard.js";

const running: QuotaDashboard[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((dashboard) => dashboard.stop())); });

const state: DashboardState = {
  codex: { value: { capturedAt: 1000, fiveHour: { label: "5h", remainingPercent: 73 } } },
  antigravity: { error: "Query failed" },
  usage: { totals: { input: 200, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 240 }, models: [
    { provider: "openai-codex", model: "gpt", input: 200, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 240,
      estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1, unpricedTokens: 240 },
  ], timeline: { hours: [], days: [], today: "2026-06-01", currentHour: 1780300800000 },
  pricing: { asOf: "2026-09-23", estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1, unpricedTokens: 240 },
  records: 1, invalidRecords: 0, updatedAt: Date.now(), stale: false },
  context: { tokens: 70720, contextWindow: 272000, percent: 26 },
  quotaEstimates: { codex: { fiveHour: { note: "n/a" }, weekly: { note: "n/a" } }, antigravity: { groups: [] } },
  config: { refreshIntervalSeconds: 180, staleAfterSeconds: 60, requestTimeoutSeconds: 10, showReset: true,
    showOaiInStatusbar: true, showAgyInStatusbar: true },
  updatedAt: Date.now(),
};

it("serves a loopback-only, credential-free dashboard and closes on shutdown", async () => {
  const refresh = vi.fn(async () => {});
  const setInterval = vi.fn(async (seconds: number) => { state.config.refreshIntervalSeconds = seconds; });
  const setStatusbar = vi.fn(async (settings: Partial<Pick<typeof state.config, "showOaiInStatusbar" | "showAgyInStatusbar">>) => { Object.assign(state.config, settings); });
  const dashboard = new QuotaDashboard({ state: () => state, refresh, setInterval, setStatusbar });
  running.push(dashboard);
  const origin = await dashboard.start();
  expect(await dashboard.start()).toBe(origin);
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(origin);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  const html = await page.text();
  expect(html).toContain("概览");
  expect(html).toContain("Token 消耗趋势");
  expect(html).toContain("chart-model");
  expect([...html.matchAll(/<section class="section /g)]).toHaveLength(3);
  expect([...html.matchAll(/<h2 id="[^"]+">([^<]+)/g)].map((match) => match[1]))
    .toEqual(["概览", "剩余额度", "用量"]);
  expect(html).toContain("关于数据");
  expect(html).toContain("状态与设置");
  expect(html).toContain("当前周期可计价用量的公开 API 标价");
  expect(html).toContain("在 pi-web 扩展状态栏显示 OAI");
  expect(html).toContain("在 pi-web 扩展状态栏显示 AGY");
  expect(html).not.toContain("当前会话 Token");
  expect(html).not.toContain("Cost");
  const css = await (await fetch(`${origin}/style.css`)).text();
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("#245bce");
  expect(css).toContain(".chart-line");
  expect(css).toContain(".overview-section { --section-accent:");
  expect(css).toContain(".usage-section { --section-accent:");
  expect(css).toContain(".quota-section { --section-accent:");
  expect(css).toContain(".quota-money");
  const js = await fetch(`${origin}/client.js`);
  expect(js.status).toBe(200);
  const client = await js.text();
  expect(client).toContain("/api/refresh");
  expect(client).toContain("/api/statusbar");
  expect(client).toContain("quota-group");
  Object.assign(state.usage, { ledgerPath: "/secret/usage.jsonl", credential: "secret" });
  Object.assign(state.usage.models[0], { ledgerPath: "/secret/usage.jsonl" });
  state.usage.timeline.hours.push({ bucket: String(Date.now()), provider: "openai-codex", model: "gpt", totalTokens: 240 });
  Object.assign(state.usage.timeline.hours[0], { ledgerPath: "/secret/usage.jsonl" });
  Object.assign(state.usage.pricing, { credential: "secret" });
  const result = await fetch(`${origin}/api/state`);
  const payload = await result.json() as DashboardState & { control: string };
  expect(payload.codex.value?.fiveHour?.remainingPercent).toBe(73);
  expect(payload.usage.models[0]?.provider).toBe("openai-codex");
  expect(payload.usage.totals.totalTokens).toBe(240);
  expect(payload.usage.timeline.hours[0]).toEqual({ bucket: state.usage.timeline.hours[0].bucket, provider: "openai-codex", model: "gpt", totalTokens: 240 });
  expect(payload.context).toEqual({ tokens: 70720, contextWindow: 272000, percent: 26 });
  expect(payload.quotaEstimates).toEqual(state.quotaEstimates);
  expect((payload.usage.pricing as typeof payload.usage.pricing & { catalog: unknown[] }).catalog)
    .toContainEqual(expect.objectContaining({ model: "gpt-6-sol", rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }));
  expect(JSON.stringify(payload)).not.toContain("Bearer");
  expect(JSON.stringify(payload)).not.toContain("daily");
  expect(JSON.stringify(payload)).not.toContain("/usage-");
  expect(JSON.stringify(payload)).not.toContain("/secret/");
  expect(JSON.stringify(payload)).not.toContain("credential");
  expect(Object.keys(payload.config)).toEqual(["refreshIntervalSeconds", "showOaiInStatusbar", "showAgyInStatusbar"]);
  expect(payload.config).toMatchObject({ showOaiInStatusbar: true, showAgyInStatusbar: true });
  expect(Object.keys(payload.usage)).toEqual(["totals", "models", "pricing", "records", "invalidRecords", "timeline", "updatedAt", "stale"]);

  const blocked = await fetch(`${origin}/api/refresh`, { method: "POST", headers: { Origin: "https://evil.example", "X-Quota-Control": payload.control } });
  expect(blocked.status).toBe(403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(`${origin}/api/state`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
  expect(wrongHost).toBe(403);
  const headers = { Origin: origin, "X-Quota-Control": payload.control, "Content-Type": "application/json" };
  const invalid = await fetch(`${origin}/api/interval`, { method: "POST", headers, body: JSON.stringify({ seconds: 1 }) });
  expect(invalid.status).toBe(400);
  expect(setInterval).not.toHaveBeenCalled();
  const saved = await fetch(`${origin}/api/interval`, { method: "POST", headers, body: JSON.stringify({ seconds: 240 }) });
  expect(saved.status).toBe(200);
  expect(setInterval).toHaveBeenCalledWith(240);
  const invalidStatusbar = await fetch(`${origin}/api/statusbar`, { method: "POST", headers, body: JSON.stringify({ showOaiInStatusbar: "false" }) });
  expect(invalidStatusbar.status).toBe(400);
  expect(setStatusbar).not.toHaveBeenCalled();
  const savedStatusbar = await fetch(`${origin}/api/statusbar`, { method: "POST", headers, body: JSON.stringify({ showOaiInStatusbar: false }) });
  expect(savedStatusbar.status).toBe(200);
  expect(setStatusbar).toHaveBeenCalledWith({ showOaiInStatusbar: false });
  const refreshed = await fetch(`${origin}/api/refresh`, { method: "POST", headers });
  expect(refreshed.status).toBe(200);
  expect(refresh).toHaveBeenCalledOnce();
  await dashboard.stop();
  running.pop();
  await expect(fetch(`${origin}/api/state`)).rejects.toThrow();
});
