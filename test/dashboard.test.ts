import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { QuotaDashboard, type DashboardState } from "../src/dashboard.js";

const running: QuotaDashboard[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((dashboard) => dashboard.stop())); });

const state: DashboardState = {
  codex: { value: { capturedAt: 1000, fiveHour: { label: "5h", remainingPercent: 73 } } },
  claude: { value: { capturedAt: 1000, weekly: { label: "weekly", remainingPercent: 65 } } },
  antigravity: { error: "Query failed" },
  usage: { totals: { input: 200, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 240 }, models: [
    { provider: "openai-codex", model: "gpt", input: 200, output: 40, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 240,
      estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1, unpricedTokens: 240 },
  ], timeline: { hours: [], days: [], today: "2026-06-01", currentHour: 1780300800000 },
  pricing: { asOf: "2026-09-23", estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1, unpricedTokens: 240 },
  records: 1, invalidRecords: 0, updatedAt: Date.now(), stale: false },
  context: { tokens: 70720, contextWindow: 272000, percent: 26 },
  quotaEstimates: { codex: { fiveHour: { note: "n/a" }, weekly: { note: "n/a" } }, claude: { fiveHour: { note: "n/a" }, weekly: { note: "n/a" } }, antigravity: { groups: [] } },
  config: { dashboardPort: 38457, refreshIntervalSeconds: 180, staleAfterSeconds: 60, requestTimeoutSeconds: 10, showReset: true,
    showOaiInStatusbar: true, showClaudeInStatusbar: true, showAgyInStatusbar: true, showGrokInStatusbar: true,
    showCodexCard: true, showClaudeCard: true, showGrokCard: true, showAgyCard: true },
  updatedAt: Date.now(),
};

it("serves a loopback-only, credential-free dashboard and closes on shutdown", async () => {
  const refresh = vi.fn(async () => {});
  const setInterval = vi.fn(async (seconds: number) => { state.config.refreshIntervalSeconds = seconds; });
  const setStatusbar = vi.fn(async (settings: Partial<Pick<typeof state.config, "showOaiInStatusbar" | "showClaudeInStatusbar" | "showAgyInStatusbar" | "showGrokInStatusbar">>) => { Object.assign(state.config, settings); });
  const dashboard = new QuotaDashboard({ state: () => state, refresh, setInterval, setStatusbar, setPort: async () => {} });
  running.push(dashboard);
  const origin = await dashboard.start(0);
  expect(await dashboard.start()).toBe(origin);
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(origin);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
  const html = await page.text();
  expect(html).toContain("概览");
  expect(html).toContain("Token 与金额消耗趋势");
  expect(html).toContain('id="cost-chart"');
  expect(html).toContain('id="cost-chart-summary"');
  expect(html).not.toContain('id="codex-period-chart"');
  expect(html).not.toContain('id="codex-period-details"');
  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  expect(html).toContain("chart-model");
  expect(html).toContain("usage-account");
  expect([...html.matchAll(/<section class="section /g)]).toHaveLength(3);
  expect([...html.matchAll(/<h2 id="[^"]+"[^>]*>([^<]+)/g)].map((match) => match[1]))
    .toEqual(["剩余额度", "账本概览", "用量分析"]);
  expect(html).toContain('class="skip-link"');
  expect(html).toContain('aria-label="页面导航"');
  expect(html).toContain('id="connection-status"');
  expect(html).toContain('id="model-comparison-list"');
  expect(html).toContain("关于数据");
  expect(html).toContain("状态与设置");
  expect(html).toContain("两次已保存读数之间的 Token 时间戳匹配账本金额");
  expect(html).toContain("状态栏显示 OAI");
  expect(html).toContain("状态栏显示 AGY");
  expect(html).toContain("状态栏显示 CLA");
  expect(html).toContain("状态栏显示 GRK");
  expect(html).toContain('id="claude-windows"');
  expect(html).toContain('id="grok-windows"');
  for (const id of ["account-switch-dialog", "account-switch-profile", "account-switch-confirm",
    "account-add-dialog", "account-manage-dialog", "account-history-dialog",
    "account-save-form", "account-import-form", "account-manage-profile", "account-delete",
    "backup-location", "backup-directory", "backup-restore-path", "account-backup", "account-backup-create", "account-restore", "account-restore-path", "account-reset-profile", "account-reset-usage"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const controls = [...html.matchAll(/<details class="account-menu"[^>]*>([\s\S]*?)<\/details>/g)];
  expect(controls).toHaveLength(3);
  for (const [index, prefix] of ["codex", "claude", "grok"].entries()) {
    expect(controls[index][0]).toContain(`id="${prefix}-account-menu"`);
    expect([...controls[index][1].matchAll(/<button[^>]+>([^<]+)<\/button>/g)].map((match) => match[1]))
      .toEqual(["切换账号", "新增账号", "管理账号", "历史记录"]);
    expect(controls[index][1]).toContain(`id="${prefix}-account-current"`);
    expect(controls[index][1]).not.toContain('id="usage-account"');
  }
  expect(html.slice(0, html.indexOf('<main'))).not.toContain('class="account-menu"');
  expect(html).not.toContain('id="agy-account-menu"');
  expect(html.indexOf('id="usage-account"')).toBeGreaterThan(html.indexOf('class="overview-card-header"'));
  expect(html).toContain("备份与恢复包含所有服务");
  // Dialogs live outside the main data flow instead of adding clutter to the usage section.
  expect(html.indexOf('id="account-switch-dialog"')).toBeGreaterThan(html.indexOf('</main>'));
  expect(html).toContain('<option value="all">总体用量</option>');
  expect(html).not.toContain("未归属历史");
  expect(html).not.toContain('id="account-reset-cache"');
  expect(html).not.toContain("当前会话 Token");
  expect(html).not.toContain("Cost");
  const css = await (await fetch(`${origin}/style.css`)).text();
  expect(css).toMatch(/prefers-color-scheme:\s*dark/);
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  expect(css).toMatch(/forced-colors:\s*active/);
  expect(css).toContain(".chart-line");
  expect(css).toContain(".quota-meter");
  expect(css).toContain(".trend-grid");
  expect(css).toContain(":focus-visible");
  expect(css).toContain(".quota-money");
  const enhanced = await fetch(`${origin}/enhance.js`);
  expect(enhanced.status).toBe(200);
  expect(enhanced.headers.get("Content-Type")).toContain("text/javascript");
  expect(await enhanced.text()).toContain("updateQuotaContent");
  const favicon = await fetch(`${origin}/favicon.svg`);
  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("Content-Type")).toContain("image/svg+xml");
  expect(await favicon.text()).toContain(">π</text>");
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
  expect(payload.claude.value?.weekly?.remainingPercent).toBe(65);
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
  expect(Object.keys(payload.config)).toEqual(["dashboardPort", "refreshIntervalSeconds", "showOaiInStatusbar", "showClaudeInStatusbar", "showAgyInStatusbar", "showGrokInStatusbar", "showCodexCard", "showClaudeCard", "showGrokCard", "showAgyCard"]);
  expect(payload.config).toMatchObject({ showOaiInStatusbar: true, showClaudeInStatusbar: true, showAgyInStatusbar: true, showGrokInStatusbar: true });
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
  expect((await fetch(`${origin}/api/statusbar`, { method: "POST", headers, body: JSON.stringify({ showClaudeInStatusbar: false }) })).status).toBe(200);
  expect(setStatusbar).toHaveBeenCalledWith({ showClaudeInStatusbar: false });
  expect((await fetch(`${origin}/api/statusbar`, { method: "POST", headers, body: JSON.stringify({ showGrokInStatusbar: false }) })).status).toBe(200);
  expect(setStatusbar).toHaveBeenCalledWith({ showGrokInStatusbar: false });
  const refreshed = await fetch(`${origin}/api/refresh`, { method: "POST", headers });
  expect(refreshed.status).toBe(200);
  expect(refresh).toHaveBeenCalledOnce();
  await dashboard.stop();
  running.pop();
  await expect(fetch(`${origin}/api/state`)).rejects.toThrow();
});

it("validates and persists only same-origin boolean card preferences, independently of other actions", async () => {
  const local = { ...state, config: { ...state.config, showClaudeInStatusbar: true, showCodexCard: true, showClaudeCard: true, showGrokCard: true, showAgyCard: true } };
  const setCards = vi.fn(async (settings: object) => { Object.assign(local.config, settings); });
  const refresh = vi.fn(async () => {}), setStatusbar = vi.fn(async () => {}), accountCommand = vi.fn(async () => {});
  const dashboard = new QuotaDashboard({ state: () => local, refresh, setStatusbar, accountCommand,
    setInterval: async () => {}, setPort: async () => {}, setCards });
  running.push(dashboard);
  const origin = await dashboard.start(0), { control } = await (await fetch(`${origin}/api/state`)).json();
  const headers = { Origin: origin, "X-Quota-Control": control, "Content-Type": "application/json" };
  const post = (body: unknown, h = headers) => fetch(`${origin}/api/cards`, { method: "POST", headers: h, body: JSON.stringify(body) });
  expect((await post({ showClaudeCard: false }, { ...headers, Origin: "https://other.example" })).status).toBe(403);
  expect((await post({ showClaudeCard: false }, { ...headers, "X-Quota-Control": "wrong" })).status).toBe(403);
  for (const body of [null, [], {}, { showClaudeCard: "false" }, { showGrokCard: 0 }, { showCodexCard: false, arbitrary: true }, { showOaiInStatusbar: false }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(setCards).not.toHaveBeenCalled();
  expect((await post({ showClaudeCard: false, showGrokCard: false })).status).toBe(200);
  expect(setCards).toHaveBeenCalledWith({ showClaudeCard: false, showGrokCard: false });
  const saved = await (await fetch(`${origin}/api/state`)).json();
  expect(saved.config).toMatchObject({ showCodexCard: true, showClaudeCard: false, showGrokCard: false, showAgyCard: true, showClaudeInStatusbar: true });
  expect(refresh).not.toHaveBeenCalled(); expect(setStatusbar).not.toHaveBeenCalled(); expect(accountCommand).not.toHaveBeenCalled();
  setCards.mockRejectedValueOnce(new Error("disk failure"));
  expect((await post({ showClaudeCard: true })).status).toBe(500);
  expect((await (await fetch(`${origin}/api/state`)).json()).config.showClaudeCard).toBe(false);
});

it("requires same-origin control and a bounded model selection before deleting usage", async () => {
  const deleteUsage = vi.fn(async () => ({ removed: 2 }));
  const dashboard = new QuotaDashboard({ state: () => state, refresh: async () => {}, setInterval: async () => {},
    setStatusbar: async () => {}, setPort: async () => {}, deleteUsage });
  running.push(dashboard);
  const origin = await dashboard.start(0);
  const { control } = await (await fetch(`${origin}/api/state`)).json() as { control: string };
  const headers = { Origin: origin, "X-Quota-Control": control, "Content-Type": "application/json" };
  const post = (body: unknown, requestHeaders = headers) => fetch(`${origin}/api/usage-delete`, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  });
  expect((await post({ account: "all", provider: "subagent-unattributed", model: "unknown-subagent" },
    { ...headers, Origin: "https://other.example" })).status).toBe(403);
  for (const body of [{ account: "", provider: "antigravity", model: "x" }, { account: "account:", provider: "a", model: "b" },
    { account: "all", provider: "", model: "x" }, { account: "all", provider: "a", model: "x".repeat(300) },
    { account: "all", provider: "a", model: 1 }]) expect((await post(body)).status).toBe(400);
  expect(deleteUsage).not.toHaveBeenCalled();
  const response = await post({ account: "all", provider: "subagent-unattributed", model: "unknown-subagent" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, removed: 2 });
  expect(deleteUsage).toHaveBeenCalledOnce();
  expect(deleteUsage).toHaveBeenCalledWith("all", "subagent-unattributed", "unknown-subagent");
});

it("queues only allowlisted account commands behind the dashboard control check", async () => {
  const accountCommand = vi.fn(async (_command: string, _args: string) => {});
  const dashboard = new QuotaDashboard({
    state: async () => ({ ...state, profiles: [{ name: "pro", accountId: "pro-id" }], backups: ["/private/backup.json"] }),
    refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {}, setPort: async () => {}, accountCommand,
  });
  running.push(dashboard);
  const origin = await dashboard.start(0);
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
  for (const [command, args] of [["use", "anthropic same"], ["save", "xai"], ["note", `account:${"a".repeat(64)} 工作号`],
    ["reset-usage", `account:${"b".repeat(64)}`], ["reset-cache", "anthropic"]]) {
    expect((await post({ command, args })).status).toBe(200);
    expect(accountCommand).toHaveBeenCalledWith(command, args);
  }
  for (const body of [{ command: "unknown", args: "pro" }, { command: "use", args: "pro\n/other" },
    { command: "import", args: "pro" }, { command: "reset-usage", args: "../pro" },
    { command: "backup", args: "relative/path" }, { command: "use", args: "agy work" },
    { command: "note", args: `account:${"a".repeat(64)} ${"x".repeat(121)}` }, { command: "note", args: "pro unsafe\u001bnote" }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect((await post({ command: "use", args: "pro" }, { ...headers, Origin: "https://evil.example" })).status).toBe(403);
  expect(accountCommand).toHaveBeenCalledTimes(8);
});

it("allowlists account, profile and quota-owner metadata so credentials cannot reach the state endpoint", async () => {
  const secret = "private-access-must-not-leak", id = `account:${"a".repeat(64)}`;
  const dashboard = new QuotaDashboard({
    state: () => ({ ...state,
      accounts: [{ id, name: "Claude · 工作号", provider: "anthropic", access: secret } as any],
      profiles: [{ name: "work", provider: "anthropic", credential: { access: secret, refresh: secret } } as any],
      currentAccounts: { anthropic: { id, name: "Claude · 工作号", current: true, access: secret } as any },
      quotaAccounts: { anthropic: { id, name: "Claude · 工作号", current: false, credential: { access: secret } } as any },
    }), refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {}, setPort: async () => {},
  });
  running.push(dashboard);
  const origin = await dashboard.start(0), response = await (await fetch(`${origin}/api/state`)).text();
  expect(response).not.toContain(secret);
  const payload = JSON.parse(response);
  expect(payload.profiles).toEqual([{ name: "work", provider: "anthropic" }]);
  expect(payload.currentAccounts.anthropic).toEqual({ id, name: "Claude · 工作号", current: true });
  expect(payload.quotaAccounts.anthropic).toEqual({ id, name: "Claude · 工作号", current: false });
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
    refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {}, setPort: async () => {},
  });
  running.push(dashboard);
  const origin = await dashboard.start(0);
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
