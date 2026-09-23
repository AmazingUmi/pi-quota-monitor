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
  queryAntigravityQuota: vi.fn(async () => ({ capturedAt: Date.now(), groups: [], models: [
    { modelId: "gemini-test", remainingPercent: 84 }, { modelId: "claude-test", remainingPercent: 67 },
  ] })),
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
  expect(statuses[0]).toContain("OAI ?/? | AGY G? C?");
  await vi.waitFor(() => expect(statuses.at(-1)).toContain("OAI 73%/61% | AGY G84% C67%"));
  await fire("message_end", { message: {
    role: "assistant", provider: "openai-codex", model: "gpt", timestamp: Date.now(), stopReason: "stop",
    usage: { input: 100, output: 20, reasoning: 10, cacheRead: 5, cacheWrite: 3, totalTokens: 128 },
  } });
  expect(statuses.at(-1)).toContain("↑100 ↓20");
  await fire("session_shutdown");
  cleanup.pop();
  expect(statuses.at(-1)).toBeUndefined();
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
