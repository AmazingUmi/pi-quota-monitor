import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { QuotaDashboard, type DashboardState } from "../src/dashboard.js";

const running: QuotaDashboard[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((dashboard) => dashboard.stop())); });

const state: DashboardState = {
  codex: { value: { capturedAt: 1000, fiveHour: { label: "5h", remainingPercent: 73 } } },
  antigravity: { error: "Query failed" },
  session: { input: 100, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
  daily: { input: 200, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 240 },
  config: { refreshIntervalSeconds: 180, staleAfterSeconds: 60, requestTimeoutSeconds: 10, showReset: true },
  updatedAt: Date.now(),
};

it("serves a loopback-only, credential-free dashboard and closes on shutdown", async () => {
  const refresh = vi.fn(async () => {});
  const setInterval = vi.fn(async (seconds: number) => { state.config.refreshIntervalSeconds = seconds; });
  const dashboard = new QuotaDashboard({ state: () => state, refresh, setInterval });
  running.push(dashboard);
  const origin = await dashboard.start();
  expect(await dashboard.start()).toBe(origin);
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(origin);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain("额度控制台");
  const js = await fetch(`${origin}/client.js`);
  expect(js.status).toBe(200);
  expect(await js.text()).toContain("/api/refresh");
  const result = await fetch(`${origin}/api/state`);
  const payload = await result.json() as DashboardState & { control: string };
  expect(payload.codex.value?.fiveHour?.remainingPercent).toBe(73);
  expect(JSON.stringify(payload)).not.toContain("Bearer");

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
  const refreshed = await fetch(`${origin}/api/refresh`, { method: "POST", headers });
  expect(refreshed.status).toBe(200);
  expect(refresh).toHaveBeenCalledOnce();
  await dashboard.stop();
  running.pop();
  await expect(fetch(`${origin}/api/state`)).rejects.toThrow();
});
