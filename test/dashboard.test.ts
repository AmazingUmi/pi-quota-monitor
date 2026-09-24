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
  expect(html).toContain("Token 与金额消耗趋势");
  expect(html).toContain('id="cost-chart"');
  expect(html).toContain('id="cost-chart-summary"');
  expect(html).toContain("chart-model");
  expect(html).toContain("usage-account");
  expect([...html.matchAll(/<section class="section /g)]).toHaveLength(4);
  expect([...html.matchAll(/<h2 id="[^"]+">([^<]+)/g)].map((match) => match[1]))
    .toEqual(["控制管理", "概览", "剩余额度", "用量"]);
  expect(html).toContain("关于数据");
  expect(html).toContain("状态与设置");
  expect(html).toContain("当前周期可计价用量的公开 API 标价");
  expect(html).toContain("在 pi-web 扩展状态栏显示 OAI");
  expect(html).toContain("在 pi-web 扩展状态栏显示 AGY");
  for (const id of ["account-use", "account-switch-dialog", "account-switch-profile", "account-switch-confirm",
    "account-add", "account-manage", "account-history", "account-add-dialog", "account-manage-dialog", "account-history-dialog",
    "account-save-form", "account-import-form", "account-manage-profile", "account-delete",
    "backup-location", "backup-directory", "backup-restore-path", "account-backup", "account-backup-create", "account-restore", "account-restore-path", "account-reset-profile", "account-reset-usage"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const controls = html.slice(html.indexOf('<section class="section control-section'), html.indexOf('<section class="section overview-section'));
  expect([...controls.matchAll(/<button[^>]+>([^<]+)<\/button>/g)].map((match) => match[1]))
    .toEqual(["切换账号", "新增账号", "管理账号", "历史记录"]);
  expect(controls).toContain('id="usage-account"');
  expect(controls).toContain('id="account-current"');
  expect(html.indexOf('id="usage-account"')).toBeLessThan(html.indexOf('id="overview-title"'));
  expect(html.indexOf('id="account-current"')).toBeLessThan(html.indexOf('id="overview-title"'));
  expect(html.indexOf('id="account-backup"')).toBeLessThan(html.indexOf('id="tokens"'));
  expect(html.indexOf('id="account-reset-usage"')).toBeLessThan(html.indexOf('id="tokens"'));
  expect(html).toContain('<option value="all">总体用量</option>');
  expect(html).not.toContain("未归属历史");
  expect(html).not.toContain('id="account-reset-cache"');
  expect(html).not.toContain("当前会话 Token");
  expect(html).not.toContain("Cost");
  const css = await (await fetch(`${origin}/style.css`)).text();
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("#245bce");
  expect(css).toContain(".chart-line");
  expect(css).toContain(".control-section { --section-accent:");
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
  expect(client).toContain("selectedAccount");
  Object.assign(state.usage, { ledgerPath: "/secret/usage.jsonl", credential: "secret" });
  Object.assign(state.usage.models[0], { ledgerPath: "/secret/usage.jsonl" });
  state.usage.timeline.hours.push({ bucket: String(Date.now()), provider: "openai-codex", model: "gpt", totalTokens: 240,
    estimatedCostUsd: 0.02, pricedRecords: 1, unpricedRecords: 0 });
  Object.assign(state.usage.timeline.hours[0], { ledgerPath: "/secret/usage.jsonl" });
  Object.assign(state.usage.pricing, { credential: "secret" });
  const result = await fetch(`${origin}/api/state`);
  const payload = await result.json() as DashboardState & { control: string };
  expect(payload.codex.value?.fiveHour?.remainingPercent).toBe(73);
  expect(payload.usage.models[0]?.provider).toBe("openai-codex");
  expect(payload.usage.totals.totalTokens).toBe(240);
  expect(payload.usage.timeline.hours[0]).toEqual({ bucket: state.usage.timeline.hours[0].bucket, provider: "openai-codex", model: "gpt", totalTokens: 240,
    estimatedCostUsd: 0.02, pricedRecords: 1, unpricedRecords: 0 });
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

it("queues only allowlisted account commands behind the dashboard control check", async () => {
  const accountCommand = vi.fn(async (_command: string, _args: string) => {});
  const dashboard = new QuotaDashboard({
    state: async () => ({ ...state, profiles: [{ name: "pro", accountId: "pro-id" }], backups: ["/private/backup.json"] }),
    refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {}, accountCommand,
  });
  running.push(dashboard);
  const origin = await dashboard.start();
  const payload = await (await fetch(`${origin}/api/state`)).json() as DashboardState & { control: string };
  expect(payload.profiles).toEqual([{ name: "pro", accountId: "pro-id" }]);
  expect(payload.backups).toEqual(["/private/backup.json"]);
  const headers = { Origin: origin, "X-Quota-Control": payload.control, "Content-Type": "application/json" };
  const post = (body: unknown, requestHeaders: Record<string, string> = headers) => fetch(`${origin}/api/account-command`, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  });
  expect((await post({ command: "use", args: "pro" })).status).toBe(200);
  expect(accountCommand).toHaveBeenCalledWith("use", "pro");
  expect((await post({ command: "import", args: "plus /path with spaces.json" })).status).toBe(200);
  expect(accountCommand).toHaveBeenCalledWith("import", "plus /path with spaces.json");
  expect((await post({ command: "backup", args: "/private/backup dir" })).status).toBe(200);
  expect(accountCommand).toHaveBeenCalledWith("backup", "/private/backup dir");
  for (const body of [{ command: "unknown", args: "pro" }, { command: "use", args: "pro\n/other" },
    { command: "import", args: "pro" }, { command: "reset-usage", args: "../pro" },
    { command: "backup", args: "relative/path" }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect((await post({ command: "use", args: "pro" }, { ...headers, Origin: "https://evil.example" })).status).toBe(403);
  expect(accountCommand).toHaveBeenCalledTimes(3);
});

it("labels the all-accounts view and hides active Codex quota in other ledger views", async () => {
  const dashboard = new QuotaDashboard({
    state: (requested) => ({ ...state,
      accounts: [{ id: "all", name: "总体用量" }, { id: "account:pro", name: "Pro" }, { id: "account:plus", name: "Plus" }],
      currentAccountId: "account:pro", selectedAccountId: requested === "account:plus" || requested === "all" ? requested : "account:pro",
      codex: requested === "account:plus" || requested === "all" ? {} : state.codex,
      quotaEstimates: requested === "account:plus" || requested === "all"
        ? { ...state.quotaEstimates, codex: { fiveHour: { note: "此额度窗口暂无数据" }, weekly: { note: "此额度窗口暂无数据" } } }
        : state.quotaEstimates,
    }),
    refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {},
  });
  running.push(dashboard);
  const origin = await dashboard.start();
  const payload = await (await fetch(`${origin}/api/state?account=account%3Aplus`)).json() as DashboardState;
  expect(payload.selectedAccountId).toBe("account:plus");
  expect(payload.currentAccountId).toBe("account:pro");
  expect(payload.codex).toEqual({});
  expect(payload.quotaEstimates.codex.weekly.estimatedPeriodUsd).toBeUndefined();
  const all = await (await fetch(`${origin}/api/state?account=all`)).json() as DashboardState;
  expect(all.selectedAccountId).toBe("all");
  expect(all.accounts?.[0]).toEqual({ id: "all", name: "总体用量" });
  expect(all.codex).toEqual({});
  expect(all.quotaEstimates.codex.fiveHour.estimatedPeriodUsd).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain("refresh-token");
});
