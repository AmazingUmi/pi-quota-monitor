import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexQuota, AntigravityQuota } from "../src/types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createServer, type AddressInfo } from "node:net";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";
import quotaMonitor from "../src/index.js";
import { appendUsage } from "../src/tokens/store.js";

const stored = vi.hoisted(() => ({ root: "", account: "test-account", data: new Map<string, Array<CodexQuota | AntigravityQuota>>(), saved: vi.fn() }));
vi.mock("../src/quota-readings.js", () => ({ QuotaReadings: class {
  constructor(private provider: string, private account?: string) {}
  async load() { return stored.data.get(`${this.provider}:${this.account ?? "shared"}`) ?? []; }
  async append(value: CodexQuota | AntigravityQuota) {
    stored.saved(this.provider, this.account, value);
    const key = `${this.provider}:${this.account ?? "shared"}`;
    stored.data.set(key, [...(stored.data.get(key) ?? []), value]);
  }
} }));
vi.mock("../src/accounts.js", () => ({
  activeAccountId: () => stored.account,
  listAccounts: async () => ({ current: stored.account, profiles: [{ name: stored.account, accountId: stored.account }] }),
  deleteAccount: vi.fn(), importAccount: vi.fn(), saveAccount: vi.fn(), useAccount: vi.fn(),
}));
vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return { ...original, configDirectory: () => stored.root, loadConfig: vi.fn(async () => ({ ...original.DEFAULT_CONFIG, dashboardPort: 0 })), saveConfig: vi.fn(async () => {}) };
});
vi.mock("../src/tokens/store.js", () => ({
  localDate: () => "2026-06-01", readDailyUsage: vi.fn(async () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })), appendUsage: vi.fn(async () => {}),
}));
vi.mock("../src/providers/codex.js", () => ({
  queryCodexQuota: vi.fn(async () => ({ capturedAt: Date.now(), fiveHour: { label: "5h", remainingPercent: 73 }, weekly: { label: "weekly", remainingPercent: 61 } })),
}));
vi.mock("../src/providers/antigravity.js", () => ({
  queryAntigravityQuota: vi.fn(async () => ({ capturedAt: Date.now(), groups: [
    { name: "Gemini", windows: [{ label: "5h", remainingPercent: 84 }, { label: "Weekly", remainingPercent: 67 }] },
  ], models: [] })),
  queryNativeAntigravityQuota: vi.fn(async () => ({ capturedAt: Date.now(), groups: [
    { name: "Gemini", windows: [{ label: "5h", remainingPercent: 84 }, { label: "Weekly", remainingPercent: 67 }] },
    { name: "Claude/GPT", windows: [{ label: "weekly", remainingPercent: 100 }] },
  ], models: [] })),
}));

const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
  stored.root = await mkdtemp(join(tmpdir(), "quota-lifecycle-"));
  stored.account = "test-account";
  stored.data.clear(); stored.saved.mockClear();
});
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  await rm(stored.root, { recursive: true, force: true });
});

it("emits a pi-web-compatible RPC status, updates on tokens, and cleans up at shutdown", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const statuses: Array<string | undefined> = [];
  const pi = {
    on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, fn); },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  quotaMonitor(pi);
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_key: string, text?: string) => statuses.push(text), notify: vi.fn() },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }),
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey: "test" } })),
      getApiKeyForProvider: vi.fn(async () => JSON.stringify({ token: "test", projectId: "test" })),
    },
  } as unknown as ExtensionContext;
  const fire = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  cleanup.push(() => fire("session_shutdown"));
  await fire("session_start");
  expect(statuses[0]).toContain("OAI -/- | AGY -/-");
  await vi.waitFor(() => expect(statuses.at(-1)).toContain("OAI 73%/61% | AGY 84%/67%"));
  await fire("message_end", { message: {
    role: "assistant", provider: "openai-codex", model: "gpt", timestamp: Date.now(), stopReason: "stop",
    usage: { input: 100, output: 20, reasoning: 10, cacheRead: 5, cacheWrite: 3, totalTokens: 128 },
  } });
  expect(statuses.at(-1)).toContain("↑100 ↓20");
  await fire("session_shutdown");
  cleanup.pop();
  expect(statuses.at(-1)).toBeUndefined();
});

it("waits for the last ledger write before shutting down", async () => {
  let finishWrite!: () => void;
  vi.mocked(appendUsage).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getProvider: () => undefined,
      getProviderAuth: async () => undefined,
      getApiKeyForProvider: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  await fire("session_start");
  await fire("message_end", { message: {
    role: "assistant", provider: "openai-codex", model: "gpt", timestamp: Date.now(), stopReason: "stop",
    usage: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  } });
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
  let stopped = false;
  const shutdown = Promise.resolve(fire("session_shutdown")).then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finishWrite();
  await shutdown;
  expect(stopped).toBe(true);
});

it("queries the local agy provider natively without treating its sentinel as OAuth JSON", async () => {
  const { queryNativeAntigravityQuota, queryAntigravityQuota } = await import("../src/providers/antigravity.js");
  vi.mocked(queryNativeAntigravityQuota).mockClear();
  vi.mocked(queryAntigravityQuota).mockClear();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const statuses: string[] = [];
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const getApiKeyForProvider = vi.fn(async () => "agy-local-session");
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_key: string, text?: string) => { if (text) statuses.push(text); }, notify: vi.fn() },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getProvider: (provider: string) => ({ baseUrl: provider === "antigravity" ? "agy://local-stream-json" : "https://chatgpt.com/backend-api" }),
      getProviderAuth: async () => undefined, getApiKeyForProvider,
    },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanup.push(() => fire("session_shutdown"));
  await fire("session_start");
  await vi.waitFor(() => expect(statuses.at(-1)).toContain("AGY 84%/67%"));
  expect(queryNativeAntigravityQuota).toHaveBeenCalledOnce();
  expect(vi.mocked(queryNativeAntigravityQuota).mock.calls[0]?.[1]).toBe(120_000);
  expect(queryAntigravityQuota).not.toHaveBeenCalled();
  expect(getApiKeyForProvider).not.toHaveBeenCalled();
});

it("keeps selected RPC status visible in the console and applies settings without disabling quotas", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const statuses: Array<{ key: string; text?: string }> = [];
  const notices: string[] = [];
  const sendUserMessage = vi.fn();
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, options.handler); },
    sendUserMessage,
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "rpc", hasUI: true,
    ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }), notify: (message: string) => notices.push(message) },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: 70_720, contextWindow: 272_000, percent: 26 }),
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => ({ auth: { apiKey: "test" } }), getApiKeyForProvider: async () => JSON.stringify({ token: "test", projectId: "test" }) },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanup.push(() => fire("session_shutdown"));
  await fire("session_start");
  expect([...commands.keys()]).toEqual([
    "quota-account-list", "quota-account-current", "quota-account-save", "quota-account-import", "quota-account-use", "quota-account-delete",
    "quota-account-backup", "quota-account-backups", "quota-account-restore", "quota-account-reset-cache", "quota-account-reset-usage",
    "quota", "quota-console", "quota-refresh", "quota-interval",
  ]);
  await commands.get("quota-console")?.("", ctx);
  const url = notices.at(-1)?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(url).toBeDefined();
  expect(statuses.at(-1)?.key).toBe("pi-quota-monitor");
  expect(statuses.at(-1)?.text).toContain("OAI ");
  expect(statuses.at(-1)?.text).toContain("AGY ");
  await commands.get("quota")?.("console", ctx); // Keep the old spaced spelling as an alias.
  const response = await fetch(`${url}/api/state`);
  expect(response.status).toBe(200);
  const payload = await response.json() as Record<string, unknown>;
  expect(payload).toHaveProperty("usage");
  expect(payload.context).toEqual({ tokens: 70720, contextWindow: 272000, percent: 26 });
  expect(payload).not.toHaveProperty("session");
  expect(payload).not.toHaveProperty("daily");
  const control = payload.control as string;
  const headers = { Origin: url!, "X-Quota-Control": control, "Content-Type": "application/json" };
  const runningPort = Number(new URL(url!).port);
  const portSaved = await fetch(`${url}/api/port`, { method: "POST", headers, body: JSON.stringify({ port: runningPort }) });
  expect(portSaved.status).toBe(200);
  expect(vi.mocked(saveConfig)).toHaveBeenLastCalledWith(expect.objectContaining({ dashboardPort: runningPort }));
  const portState = await (await fetch(`${url}/api/state`)).json();
  expect(portState.config.dashboardPort).toBe(runningPort);
  expect(portState.dashboard.port).toBe(runningPort);
  const queued = await fetch(`${url}/api/account-command`, { method: "POST", headers, body: JSON.stringify({ command: "use", args: "pro" }) });
  expect(queued.status).toBe(200);
  expect(sendUserMessage).toHaveBeenCalledWith("/quota-account-use pro", { expandPromptTemplates: true });
  const { queryCodexQuota } = await import("../src/providers/codex.js");
  const callsBeforeRefresh = vi.mocked(queryCodexQuota).mock.calls.length;
  const saved = await fetch(`${url}/api/statusbar`, { method: "POST", headers,
    body: JSON.stringify({ showOaiInStatusbar: false, showAgyInStatusbar: false }) });
  expect(saved.status).toBe(200);
  expect(statuses.at(-1)).toEqual({ key: "pi-quota-monitor", text: "↑0 ↓0" });
  const refreshedState = await (await fetch(`${url}/api/state`)).json() as { config: Record<string, unknown> };
  expect(refreshedState.config).toMatchObject({ showOaiInStatusbar: false, showAgyInStatusbar: false });
  const refreshResponse = await fetch(`${url}/api/refresh`, { method: "POST", headers });
  expect(refreshResponse.status).toBe(200);
  expect(vi.mocked(queryCodexQuota).mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
  const periodState = await (await fetch(`${url}/api/state`)).json() as { codexPeriods: Array<{ kind: string; estimatedTotalUsd?: number }> };
  expect(periodState.codexPeriods.map((period) => period.kind).sort()).toEqual(["fiveHour", "weekly"]);
  expect(periodState.codexPeriods.every((period) => period.estimatedTotalUsd === undefined)).toBe(true);
  const callsBeforeNamedRefresh = vi.mocked(queryCodexQuota).mock.calls.length;
  await commands.get("quota-refresh")?.("", ctx);
  expect(vi.mocked(queryCodexQuota).mock.calls.length).toBeGreaterThan(callsBeforeNamedRefresh);
  await commands.get("quota")?.("", ctx);
  expect(notices.at(-1)).toContain("Codex");
  expect(statuses.at(-1)?.text).toBe("↑0 ↓0");
  await commands.get("quota-interval")?.("240", ctx);
  expect(vi.mocked(saveConfig)).toHaveBeenLastCalledWith(expect.objectContaining({ refreshIntervalSeconds: 240, dashboardPort: runningPort }));

  const tuiContext = { ...ctx, mode: "tui" } as unknown as ExtensionContext;
  await handlers.get("model_select")?.({ model: { provider: "openai-codex" } }, tuiContext);
  expect(statuses.at(-1)?.text).toContain("OAI 73%/61% | AGY 84%/67%");

  vi.mocked(saveConfig).mockRejectedValueOnce(new Error("disk full"));
  const failedSave = await fetch(`${url}/api/statusbar`, { method: "POST", headers,
    body: JSON.stringify({ showOaiInStatusbar: true }) });
  expect(failedSave.status).toBe(500);
  const failedState = await (await fetch(`${url}/api/state`)).json() as { config: Record<string, unknown> };
  expect(failedState.config).toMatchObject({ showOaiInStatusbar: false, showAgyInStatusbar: false });
  expect(statuses.at(-1)?.text).toContain("OAI 73%/61% | AGY 84%/67%");
  await fire("session_shutdown");
  cleanup.pop();
  await vi.waitFor(async () => { await expect(fetch(`${url}/api/state`)).rejects.toThrow(); });
});

it("notifies Pi about a port fallback with the real URL and a settings prompt", async () => {
  const occupied = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as AddressInfo).port;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notify = vi.fn();
  const ctx = {
    hasUI: true, ui: { setStatus: vi.fn(), notify }, sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined,
    modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  vi.mocked(loadConfig).mockResolvedValueOnce({ ...DEFAULT_CONFIG, dashboardPort: port });
  quotaMonitor({
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, options.handler); },
  } as unknown as ExtensionAPI);
  try {
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("quota-console")?.("", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining(`端口 ${port} 已被占用`), "warning");
    const message = notify.mock.calls.at(-1)![0] as string;
    expect(message).toContain("状态与设置");
    const url = message.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    expect(Number(new URL(url).port)).not.toBe(port);
    const state = await (await fetch(`${url}/api/state`)).json();
    expect(state.config.dashboardPort).toBe(port);
    expect(state.dashboard.fallbackFrom).toBe(port);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it.each(["new", "resume", "fork", "reload"])("keeps the same socket and control token across %s runtime replacement", async (reason) => {
  const create = () => {
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { setStatus: vi.fn(), notify }, sessionManager: { getBranch: () => [] },
      getContextUsage: () => undefined,
      modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
    } as unknown as ExtensionContext;
    quotaMonitor({ on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, options.handler),
    } as unknown as ExtensionAPI);
    return { handlers, commands, notify, ctx };
  };
  const first = create();
  await first.handlers.get("session_start")?.({ reason: "startup" }, first.ctx);
  await first.commands.get("quota-console")?.("", first.ctx);
  const url = first.notify.mock.calls.at(-1)![0].match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  const before = await (await fetch(`${url}/api/state`)).json();
  await first.handlers.get("session_shutdown")?.({ reason }, first.ctx);
  const between = await (await fetch(`${url}/api/state`)).json();
  expect(between.control).toBe(before.control);
  expect(between.context).toBeNull();
  expect(between.accountNotice.message).toContain("控制台保持运行");
  const unavailable = await fetch(`${url}/api/interval`, { method: "POST", headers: { Origin: url, "X-Quota-Control": before.control }, body: JSON.stringify({ seconds: 240 }) });
  expect(unavailable.status).toBe(500); // No mutation through an invalidated session context.
  const next = create(); // Pi creates a fresh extension factory after replacement.
  cleanup.push(() => next.handlers.get("session_shutdown")?.({ reason: "quit" }, next.ctx));
  await next.handlers.get("session_start")?.({ reason }, next.ctx);
  const after = await (await fetch(`${url}/api/state`)).json();
  expect(after.control).toBe(before.control);
  expect(after.dashboard.port).toBe(before.dashboard.port);
  const response = await fetch(`${url}/api/interval`, { method: "POST", headers: { Origin: url, "X-Quota-Control": after.control }, body: JSON.stringify({ seconds: 240 }) });
  expect(response.status).toBe(200); // Bound to the new generation, not a stale closure.
});

it("shows saved account-specific readings before remote queries finish and persists each success", async () => {
  const capturedAt = Date.now() - 60_000;
  stored.data.set("codex:test-account", [{ capturedAt, fiveHour: { label: "5h", remainingPercent: 42 } }]);
  stored.data.set("antigravity:shared", [{ capturedAt, groups: [{ name: "Gemini", windows: [{ label: "5h", remainingPercent: 55 }] }], models: [] }]);
  const { queryCodexQuota } = await import("../src/providers/codex.js");
  let resolve!: (value: CodexQuota) => void;
  vi.mocked(queryCodexQuota).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notify = vi.fn();
  const statuses: string[] = [];
  const ctx = { hasUI: true, ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify }, sessionManager: { getBranch: () => [] },
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => ({ auth: { apiKey: "test" } }), getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  quotaMonitor({ on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, options.handler),
  } as unknown as ExtensionAPI);
  cleanup.push(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
  await handlers.get("session_start")?.({}, ctx);
  expect(statuses[0]).toContain("OAI 42%/- | AGY 55%/-");
  await commands.get("quota-console")?.("", ctx);
  const url = notify.mock.calls.at(-1)![0].match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  const cached = await (await fetch(`${url}/api/state`)).json();
  expect(cached.codex).toMatchObject({ restored: true, value: { capturedAt, fiveHour: { remainingPercent: 42 } } });
  const live = { capturedAt: Date.now(), fiveHour: { label: "5h", remainingPercent: 40 } };
  resolve(live);
  await vi.waitFor(() => expect(stored.saved).toHaveBeenCalledWith("codex", "test-account", live));
  const current = await (await fetch(`${url}/api/state`)).json();
  expect(current.codex.restored).toBe(false);
  expect(current.codex.value.fiveHour.remainingPercent).toBe(40);
  stored.account = "other-account";
  await handlers.get("model_select")?.({ model: { provider: "openai-codex" } }, ctx);
  const switched = await (await fetch(`${url}/api/state`)).json();
  expect(switched.currentAccountId).toBe("account:other-account");
  expect(switched.codex.value?.fiveHour.remainingPercent).not.toBe(40);
});

it("ignores a provider result that arrives after shutdown", async () => {
  const { queryCodexQuota } = await import("../src/providers/codex.js");
  let resolve!: (value: Awaited<ReturnType<typeof queryCodexQuota>>) => void;
  vi.mocked(queryCodexQuota).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const statuses: Array<string | undefined> = [];
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_key: string, text?: string) => statuses.push(text), notify: vi.fn() },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => ({ auth: { apiKey: "test" } }), getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanup.push(() => fire("session_shutdown"));
  await fire("session_start");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  await fire("session_shutdown");
  cleanup.pop();
  resolve({ capturedAt: Date.now(), fiveHour: { label: "5h", remainingPercent: 73 } });
  await Promise.resolve();
  expect(statuses.at(-1)).toBeUndefined();
});
