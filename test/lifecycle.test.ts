import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "../src/config.js";
import quotaMonitor from "../src/index.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return { ...original, loadConfig: vi.fn(async () => ({ ...original.DEFAULT_CONFIG })), saveConfig: vi.fn(async () => {}) };
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

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

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
  cleanup.push(() => { void fire("session_shutdown"); });
  await fire("session_start");
  expect(statuses[0]).toContain("OAI ?/? | AGY ?/?");
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
  cleanup.push(() => { void fire("session_shutdown"); });
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
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, options.handler); },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "rpc", hasUI: true,
    ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }), notify: (message: string) => notices.push(message) },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: 70_720, contextWindow: 272_000, percent: 26 }),
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => ({ auth: { apiKey: "test" } }), getApiKeyForProvider: async () => JSON.stringify({ token: "test", projectId: "test" }) },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanup.push(() => { void fire("session_shutdown"); });
  await fire("session_start");
  expect([...commands.keys()]).toEqual(["quota", "quota-console", "quota-refresh", "quota-interval"]);
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
  const callsBeforeNamedRefresh = vi.mocked(queryCodexQuota).mock.calls.length;
  await commands.get("quota-refresh")?.("", ctx);
  expect(vi.mocked(queryCodexQuota).mock.calls.length).toBeGreaterThan(callsBeforeNamedRefresh);
  await commands.get("quota")?.("", ctx);
  expect(notices.at(-1)).toContain("Codex");
  expect(statuses.at(-1)?.text).toBe("↑0 ↓0");
  await commands.get("quota-interval")?.("240", ctx);
  expect(vi.mocked(saveConfig)).toHaveBeenLastCalledWith(expect.objectContaining({ refreshIntervalSeconds: 240 }));

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
  cleanup.push(() => { void fire("session_shutdown"); });
  await fire("session_start");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  await fire("session_shutdown");
  cleanup.pop();
  resolve({ capturedAt: Date.now(), fiveHour: { label: "5h", remainingPercent: 73 } });
  await Promise.resolve();
  expect(statuses.at(-1)).toBeUndefined();
});
