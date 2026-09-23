import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeAccountId, deleteAccount, importAccount, listAccounts, saveAccount, useAccount } from "../src/accounts.js";
import { backupHistory, importHistory, resetAccountUsage } from "../src/history.js";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { localDate, readDailyUsage } from "../src/tokens/store.js";
import quotaMonitor from "../src/index.js";
import { createAgentSession, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    expect(before?.auth.apiKey).toBeDefined();
    expect(after?.auth.apiKey).toBeDefined();
    expect(before?.auth.apiKey).not.toBe(after?.auth.apiKey);
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
    ui: { setStatus: (_key: string, status?: string) => { if (status) statuses.push(status); } },
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

it("keeps the console open and discovers an imported profile on the next state request", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
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
    const before = await (await fetch(`${url}/api/state`)).json() as { profiles: Array<{ name: string }> };
    expect(before.profiles.map((p) => p.name)).toEqual(["pro"]);
    const path = join(dir, "plus OAuth.json");
    await writeFile(path, JSON.stringify(auth("plus-id")));
    await commands.get("quota-account-import")?.(`plus ${path}`, ctx);
    expect(notices.at(-1)).toContain("已导入账号：plus");
    const after = await (await fetch(`${url}/api/state`)).json() as { profiles: Array<{ name: string }> };
    expect(after.profiles.map((p) => p.name)).toEqual(["plus", "pro"]);
  } finally { await handlers.get("session_shutdown")?.({}, ctx); }
});

it("switches through the Pi command only after idle, and requests a new session", async () => {
  const { dir } = await setup();
  await saveAccount("pro");
  const plusPath = join(dir, "plus.json");
  await writeFile(plusPath, JSON.stringify(auth("plus-id")));
  await importAccount("plus", plusPath);
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  quotaMonitor({
    on() { return () => {}; },
    registerCommand(name: string, options: { handler: typeof command }) { if (name === "quota-account-use") command = options.handler; },
  } as unknown as ExtensionAPI);
  const events: string[] = [];
  let cancel = false;
  const ctx = {
    hasUI: true,
    ui: { confirm: async () => { events.push("confirm"); return true; }, notify: () => {} },
    waitForIdle: async () => { events.push("idle"); },
    hasPendingMessages: () => false,
    newSession: async () => { events.push("newSession"); return { cancelled: cancel }; },
  } as unknown as ExtensionContext;
  await command("plus", ctx);
  expect(events).toEqual(["idle", "confirm", "newSession"]);
  expect(activeAccountId()).toBe("plus-id");
  cancel = true;
  await command("pro", ctx);
  expect(activeAccountId()).toBe("plus-id"); // Cancelled session transition rolls auth back.
});
