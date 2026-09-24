import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeAccountId, deleteAccount, importAccount, listAccounts, saveAccount, useAccount } from "../src/accounts.js";
import { backupHistory, importHistory, resetAccountUsage } from "../src/history.js";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { QuotaReadings } from "../src/quota-readings.js";
import { localDate, readDailyUsage } from "../src/tokens/store.js";
import quotaMonitor from "../src/index.js";
import { createAgentSession, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return { ...original, loadConfig: async () => ({ ...original.DEFAULT_CONFIG, dashboardPort: 0 }) };
});

const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldOffline = process.env.PI_OFFLINE;
const dirs: string[] = [];
afterEach(async () => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = oldOffline;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const auth = (id: string) => ({ type: "oauth", accountId: id, access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000 });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "quota-account-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("pro-id"), antigravity: { type: "api_key", key: "keep" } }), { mode: 0o600 });
  return { dir, authPath };
}
const record = (id?: string) => ({ timestamp: Date.now(), provider: "openai-codex", model: "gpt-6-sol", input: 100, output: 10,
  cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110, ...(id ? { accountId: id } : {}) });

it("switches native OAuth profiles, preserves refreshed tokens and other providers", async () => {
  const { dir, authPath } = await setup();
  expect(activeAccountId()).toBe("pro-id");
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")), { mode: 0o600 });
  await importAccount("plus", plusPath);
  await expect(useAccount("absent")).rejects.toThrow();
  expect(activeAccountId()).toBe("pro-id");
  const refreshed = auth("pro-id"); refreshed.access = "refreshed";
  await writeFile(authPath, JSON.stringify({ "openai-codex": refreshed, antigravity: { type: "api_key", key: "keep" } }));
  await useAccount("plus");
  expect(activeAccountId()).toBe("plus-id");
  expect((await listAccounts()).current).toBe("plus");
  expect(JSON.parse(await readFile(authPath, "utf8")).antigravity.key).toBe("keep");
  await useAccount("pro");
  expect((await readFile(join(dir, "pi-quota-monitor", "accounts", "pro.json"), "utf8"))).toContain("refreshed");
  expect(JSON.parse(await readFile(authPath, "utf8"))["openai-codex"].access).toBe("refreshed");
  expect((await stat(authPath)).mode & 0o777).toBe(0o600);
});

it("infers the active profile from auth.json without a marker and protects it", async () => {
  const { dir, authPath } = await setup();
  const obrPath = join(dir, "obr.json");
  const lyyPath = join(dir, "lyy.json");
  await writeFile(obrPath, JSON.stringify(auth("obr-id")));
  await writeFile(lyyPath, JSON.stringify(auth("lyy-id")));
  await importAccount("obr", obrPath);
  await importAccount("lyy", lyyPath);
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("obr-id") }));
  expect((await listAccounts()).current).toBe("obr");
  await expect(deleteAccount("obr")).rejects.toThrow("active profile");
  await importAccount("obr-alias", obrPath);
  await expect(deleteAccount("obr-alias")).rejects.toThrow("active profile");
  await useAccount("lyy");
  expect((await listAccounts()).current).toBe("lyy");
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("obr-id") })); // stale marker
  expect((await listAccounts()).current).toBe("obr");
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("unmatched-id") }));
  expect((await listAccounts()).current).toBeUndefined();
});

it("deletes only an inactive profile, leaving active OAuth and ledger untouched", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const path = join(dir, "plus.json");
  await writeFile(path, JSON.stringify(auth("plus-id")));
  await importAccount("plus", path);
  await expect(deleteAccount("pro")).rejects.toThrow("active profile");
  await deleteAccount("plus");
  expect((await listAccounts()).profiles.map((p) => p.name)).toEqual(["pro"]);
  expect(activeAccountId()).toBe("pro-id");
});

it("makes a same-process Pi ModelRuntime pick up the switched OAuth credential", async () => {
  const { dir } = await setup();
  process.env.PI_OFFLINE = "1";
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")));
  await importAccount("plus", plusPath);
  const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), noTools: "all" });
  try {
    const before = await session.modelRuntime.getAuth("openai-codex");
    await useAccount("plus");
    const after = await session.modelRuntime.getAuth("openai-codex");
    expect(before?.auth.apiKey).toBe("access-pro-id");
    expect(after?.auth.apiKey).toBe("access-plus-id");
  } finally { session.dispose(); }
});

it("isolates Codex ledger and cost, leaves old entries unassigned, and restores reset data idempotently", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const ledger = join(dir, "pi-quota-monitor", `usage-${localDate(Date.now())}.jsonl`);
  const content = [record("pro-id"), record("plus-id"), record()].map((r) => JSON.stringify(r) + "\n").join("");
  await writeFile(ledger, content, { mode: 0o600 });
  const pro = new UsageAggregator(join(dir, "pi-quota-monitor"), "pro-id");
  const plus = new UsageAggregator(join(dir, "pi-quota-monitor"), "plus-id");
  const legacy = new UsageAggregator(join(dir, "pi-quota-monitor"), null);
  await Promise.all([pro.refresh(), plus.refresh(), legacy.refresh()]);
  expect([pro.state().records, plus.state().records, legacy.state().records]).toEqual([1, 1, 1]);
  expect((await readDailyUsage(localDate(Date.now()), "pro-id")).totalTokens).toBe(110);
  expect((await readDailyUsage(localDate(Date.now()), "plus-id")).totalTokens).toBe(110);
  expect(pro.estimateCostForPeriod("openai-codex", Date.now() - 60_000, Date.now()).pricedRecords).toBe(1);
  const backup = await backupHistory();
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  const cleared = await resetAccountUsage("pro-id");
  expect(cleared.removed).toBe(1);
  expect(await readFile(ledger, "utf8")).not.toContain("pro-id");
  expect(await readFile(ledger, "utf8")).toContain("plus-id");
  expect((await importHistory(backup)).records).toBe(1);
  expect((await importHistory(backup)).records).toBe(0);
  expect((await readFile(ledger, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
  await expect(importAccount("current", backup)).rejects.toThrow();
  const corrupted = join(dir, "corrupted.json");
  await writeFile(corrupted, JSON.stringify({ schema: 1, profiles: [], ledgers: { "../auth.json": "{}" } }));
  await expect(importHistory(corrupted)).rejects.toThrow("Invalid backup ledger");
  expect((await readFile(ledger, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
});

it("writes manual backups only to an existing private directory chosen on the Pi machine", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const destination = await mkdtemp(join(dir, "my backups "));
  await chmod(destination, 0o700);
  const backup = await backupHistory(destination);
  expect(backup.startsWith((await realpath(destination)) + "/backup-")).toBe(true);
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({ on() { return () => {}; },
    registerCommand(name: string, options: { handler: typeof command }) { if (name === "quota-account-backup") command = options.handler; },
  } as unknown as ExtensionAPI);
  let notice = "";
  await command(destination, { hasUI: true, waitForIdle: async () => {}, ui: { notify: (text: string) => { notice = text; } } } as unknown as ExtensionContext);
  expect(notice).toContain((await realpath(destination)) + "/backup-");
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  await expect(backupHistory("relative/path")).rejects.toThrow("absolute path");
  await chmod(destination, 0o755);
  if (process.platform !== "win32") await expect(backupHistory(destination)).rejects.toThrow("private directory");
  await chmod(destination, 0o700);
  const link = join(dir, "backup-link");
  await symlink(destination, link);
  await expect(backupHistory(link)).rejects.toThrow("private directory");
});

it("refuses reset when another ledger is damaged, without partially changing valid history", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const root = join(dir, "pi-quota-monitor");
  const valid = join(root, `usage-${localDate(Date.now())}.jsonl`);
  await writeFile(valid, JSON.stringify(record("pro-id")) + "\n");
  await writeFile(join(root, "usage-2000-01-01.jsonl"), "{broken}\n");
  await expect(resetAccountUsage("pro-id")).rejects.toThrow("damaged");
  expect(await readFile(valid, "utf8")).toContain("pro-id");
});

it("attributes usage to the account captured at request time, not after a switch", async () => {
  const { dir, authPath } = await setup();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: false, model: { provider: "openai-codex" },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("before_provider_headers")?.({ headers: {} }, ctx);
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("plus-id") }));
  await handlers.get("message_end")?.({ message: { role: "assistant", provider: "openai-codex", model: "gpt-6-sol", timestamp: Date.now(), stopReason: "stop",
    usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } } }, ctx);
  await handlers.get("session_shutdown")?.({}, ctx);
  const ledger = JSON.parse((await readFile(join(dir, "pi-quota-monitor", `usage-${localDate(Date.now())}.jsonl`), "utf8")).trim());
  expect(ledger.accountId).toBe("pro-id");
});

it("discards an in-flight quota result from the previous account and re-queries the new one", async () => {
  const { authPath } = await setup();
  let completePro!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise<Response>((resolve) => { completePro = resolve; }))
    .mockResolvedValue(new Response(JSON.stringify({ plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
    } }), { status: 200 }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const statuses: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui", model: { provider: "openai-codex" },
    ui: { setStatus: (_key: string, status?: string) => { if (status) statuses.push(status); }, notify: vi.fn() },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }),
      getProviderAuth: async () => ({ auth: { apiKey: `token-${activeAccountId()}` } }), getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  try {
    await handlers.get("session_start")?.({}, ctx);
    await vi.waitFor(() => expect(completePro).toBeTypeOf("function"));
    await writeFile(authPath, JSON.stringify({ "openai-codex": auth("plus-id") }));
    await handlers.get("model_select")?.({ model: { provider: "openai-codex" } }, ctx);
    completePro(new Response(JSON.stringify({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 87, limit_window_seconds: 604800 }, secondary_window: null,
    } }), { status: 200 }));
    await vi.waitFor(() => expect(statuses.at(-1)).toContain("OAI 75%/50%"));
    expect(statuses.join(" ")).not.toContain("-/13%");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    fetcher.mockRestore();
  }
});

it("reports the active auth account name in the console without current.json", async () => {
  const { dir, authPath } = await setup();
  const path = join(dir, "obr.json");
  await writeFile(path, JSON.stringify(auth("obr-id")));
  await importAccount("obr", path);
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth("obr-id") }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let consoleCommand!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name: string, options: { handler: typeof consoleCommand }) => { if (name === "quota-console") consoleCommand = options.handler; },
  } as unknown as ExtensionAPI);
  let url = "";
  const ctx = {
    hasUI: true, mode: "rpc", ui: { setStatus() {}, notify: (message: string) => { url = message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? url; } },
    sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined,
    modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({}, ctx);
  try {
    await consoleCommand("", ctx);
    const data = await (await fetch(`${url}/api/state`)).json() as { currentProfile?: string; selectedAccountId: string; accounts: Array<{ id: string; name: string }> };
    expect(data.currentProfile).toBe("obr");
    expect(data.accounts.find((item) => item.id === data.selectedAccountId)?.name).toBe("obr");
  } finally { await handlers.get("session_shutdown")?.({}, ctx); }
});

it("keeps the console open and discovers an imported profile on the next state request", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  await writeFile(join(dir, "pi-quota-monitor", `usage-${localDate(Date.now())}.jsonl`),
    [record("pro-id"), record("plus-id"), record("plus-id")].map((item) => JSON.stringify(item) + "\n").join(""));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, options.handler); },
  } as unknown as ExtensionAPI);
  let url = "";
  const notices: string[] = [];
  const ctx = {
    hasUI: true, mode: "rpc", ui: { setStatus() {}, notify: (message: string) => { notices.push(message); url = message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? url; } },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => undefined,
    waitForIdle: async () => {},
    modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({}, ctx);
  try {
    await commands.get("quota-console")?.("", ctx);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const before = await (await fetch(`${url}/api/state`)).json() as { profiles: Array<{ name: string }>; usage: { records: number; pricing: { estimatedCostUsd: number }; timeline: { days: Array<{ estimatedCostUsd: number }> } } };
    expect(before.profiles.map((p) => p.name)).toEqual(["pro"]);
    expect(before.usage.records).toBe(1);
    const path = join(dir, "plus OAuth.json");
    await writeFile(path, JSON.stringify(auth("plus-id")));
    await commands.get("quota-account-import")?.(`plus ${path}`, ctx);
    expect(notices.at(-1)).toContain("已导入账号：plus");
    const after = await (await fetch(`${url}/api/state?account=account%3Aplus-id`)).json() as typeof before;
    expect(after.profiles.map((p) => p.name)).toEqual(["plus", "pro"]);
    expect(after.usage.records).toBe(2);
    expect(after.usage.pricing.estimatedCostUsd).toBeCloseTo(2 * before.usage.pricing.estimatedCostUsd);
    expect(after.usage.timeline.days.reduce((sum, item) => sum + item.estimatedCostUsd, 0))
      .toBeCloseTo(after.usage.pricing.estimatedCostUsd);
  } finally { await handlers.get("session_shutdown")?.({}, ctx); }
});

it("keeps quota amount estimates bound to the active account when viewing totals or another account", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")));
  await importAccount("plus", plusPath);
  await writeFile(join(dir, "pi-quota-monitor", `usage-${localDate(Date.now())}.jsonl`),
    [record("pro-id"), record("plus-id"), record("plus-id"), record()].map((item) => JSON.stringify(item) + "\n").join(""));
  await new QuotaReadings("codex", "pro-id", join(dir, "pi-quota-monitor")).append({
    capturedAt: Date.now() - 60_000, plan: "pro", weekly: { label: "weekly", remainingPercent: 60, resetAt: Math.ceil((Date.now() + 86_400_000) / 1000) * 1000 },
  });
  const originalFetch = globalThis.fetch;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => String(input).startsWith("https://chatgpt.com/")
    ? Promise.resolve(new Response(JSON.stringify({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: Math.ceil((Date.now() + 86_400_000) / 1000) },
    } }))) : originalFetch(input, init));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let consoleCommand!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name: string, options: { handler: typeof consoleCommand }) => { if (name === "quota-console") consoleCommand = options.handler; },
  } as unknown as ExtensionAPI);
  let url = "";
  const ctx = {
    hasUI: true, mode: "rpc", ui: { setStatus() {}, notify: (message: string) => { url = message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? url; } },
    sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined,
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }),
      getProviderAuth: async () => ({ auth: { apiKey: "test-only" } }), getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  try {
    await handlers.get("session_start")?.({}, ctx);
    await consoleCommand("", ctx);
    type State = { selectedAccountId: string; usage: { records: number; pricing: { estimatedCostUsd: number } };
      quotaEstimates: { codex: { weekly: { observedCostUsd?: number } } }; codex: { value?: unknown } };
    const load = async (account: string) => (await (await fetch(`${url}/api/state?account=${account}`)).json()) as State;
    await vi.waitFor(async () => expect((await load("account%3Apro-id")).quotaEstimates.codex.weekly.observedCostUsd).toBeGreaterThan(0));
    const initial = await (await fetch(`${url}/api/state`)).json() as State;
    const pro = await load("account%3Apro-id");
    const plus = await load("account%3Aplus-id");
    const all = await load("all");
    expect(initial.selectedAccountId).toBe("account:pro-id");
    expect(pro.usage.records).toBe(1);
    expect(plus.usage.records).toBe(2);
    expect(all.usage.records).toBe(4);
    expect(pro.quotaEstimates.codex.weekly.observedCostUsd).toBeCloseTo(pro.usage.pricing.estimatedCostUsd);
    expect(plus.quotaEstimates.codex.weekly.observedCostUsd).toBeUndefined();
    expect(all.quotaEstimates.codex.weekly.observedCostUsd).toBeUndefined();
    expect(plus.codex.value).toBeUndefined();
    expect(all.codex.value).toBeUndefined();
    expect(pro.codex.value).toBeDefined();
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    fetcher.mockRestore();
  }
});

it("switches like pi-auth use without depending on a cancellable session replacement", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")));
  await importAccount("plus", plusPath);
  process.env.PI_OFFLINE = "1";
  const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), noTools: "all" });
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({
    on() { return () => {}; },
    registerCommand(name: string, options: { handler: typeof command }) { if (name === "quota-account-use") command = options.handler; },
  } as unknown as ExtensionAPI);
  const events: string[] = [];
  const confirmPrompts: string[] = [];
  const notifications: string[] = [];
  const newSession = vi.fn(async () => ({ cancelled: true }));
  const ui = {
    confirm: async (_title: string, message: string) => { events.push("confirm"); confirmPrompts.push(message); return true; },
    notify: (message: string) => { notifications.push(message); },
  };
  const ctx = {
    hasUI: true, ui,
    modelRegistry: { getProviderAuth: () => session.modelRuntime.getAuth("openai-codex") },
    waitForIdle: async () => { events.push("idle"); },
    hasPendingMessages: () => false,
    newSession,
  } as unknown as ExtensionContext;
  await command("plus", ctx);
  expect(events).toEqual(["idle", "confirm"]);
  expect(confirmPrompts.at(-1)).toContain("不会强制切换当前会话");
  expect(notifications.at(-1)).toContain("已切换 Codex 账号为：plus");
  expect(activeAccountId()).toBe("plus-id");
  expect((await session.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe("access-plus-id");
  expect(newSession).not.toHaveBeenCalled();
  await command("pro", ctx);
  expect(activeAccountId()).toBe("pro-id");
  expect((await session.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe("access-pro-id");
  expect(newSession).not.toHaveBeenCalled();
  session.dispose();
});

it("rolls back when Pi resolves the previous credential despite the auth.json switch", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")));
  await importAccount("plus", plusPath);
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({ on() { return () => {}; },
    registerCommand(name: string, options: { handler: typeof command }) { if (name === "quota-account-use") command = options.handler; },
  } as unknown as ExtensionAPI);
  const notices: string[] = [];
  const newSession = vi.fn();
  await command("plus", { hasUI: true, ui: { confirm: async () => true, notify: (message: string) => notices.push(message) },
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "access-pro-id" } }) },
    waitForIdle: async () => {}, hasPendingMessages: () => false, newSession,
  } as unknown as ExtensionContext);
  expect(newSession).not.toHaveBeenCalled();
  expect(activeAccountId()).toBe("pro-id");
  expect((await listAccounts()).current).toBe("pro");
  expect(notices.at(-1)).toContain("rolled back");
});
