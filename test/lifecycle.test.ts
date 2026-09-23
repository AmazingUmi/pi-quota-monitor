import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

it("opens the console in RPC mode, hides only its own footer status, and releases the port", async () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const statuses: Array<{ key: string; text?: string }> = [];
  const notices: string[] = [];
  quotaMonitor({
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { command = options.handler; },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "rpc", hasUI: true,
    ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }), notify: (message: string) => notices.push(message) },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getProvider: () => ({ baseUrl: "https://chatgpt.com/backend-api" }), getProviderAuth: async () => undefined, getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanup.push(() => { void fire("session_shutdown"); });
  await fire("session_start");
  await command?.("console", ctx);
  const url = notices.at(-1)?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(url).toBeDefined();
  expect(statuses.at(-1)).toEqual({ key: "pi-quota-monitor", text: undefined });
  expect((await fetch(`${url}/api/state`)).status).toBe(200);
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
