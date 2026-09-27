import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import quotaMonitor from "../src/index.js";
import { queryClaudeQuota } from "../src/providers/claude.js";

vi.mock("../src/providers/claude.js", async (load) => {
  const original = await load<typeof import("../src/providers/claude.js")>();
  return { ...original, queryClaudeQuota: vi.fn(async (access: string) => ({
    accountId: access === "oauth-a" ? "identity-a" : "identity-b",
    quota: { capturedAt: Date.now(), fiveHour: { label: "5h", remainingPercent: access === "oauth-a" ? 80 : 20,
      resetAt: Date.now() + 3_600_000, windowMinutes: 300 } },
  })) };
});

const previousDir = process.env.PI_CODING_AGENT_DIR;
const directories: string[] = [];
afterEach(async () => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.mocked(queryClaudeQuota).mockClear();
});

it("uses only the active native OAuth login, clears switched quota, and attributes turns to the request account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-claude-login-"));
  directories.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  const authPath = join(dir, "auth.json");
  const login = (access: string) => ({ anthropic: { type: "oauth", access, refresh: "refresh", expires: Date.now() + 3_600_000 } });
  await writeFile(authPath, JSON.stringify(login("oauth-a")));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
  const statuses: string[] = [];
  const notices: string[] = [];
  quotaMonitor({
    on(name: string, fn: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, fn); return () => {}; },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) { commands.set(name, options.handler); },
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: true, mode: "rpc", model: { provider: "anthropic" },
    ui: { setStatus: (_key: string, text?: string) => { if (text) statuses.push(text); }, notify: (text: string) => notices.push(text) },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getProvider: (id: string) => id === "anthropic" ? { baseUrl: "https://api.anthropic.com" } : undefined,
      getProviderAuth: async (id: string) => {
        const stored = readStoredCredential(id);
        return { auth: { apiKey: stored?.type === "oauth" ? stored.access : undefined } };
      },
      getApiKeyForProvider: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const fire = (name: string, event = {}, context = ctx) => handlers.get(name)?.(event, context);
  try {
    await fire("session_start");
    await vi.waitFor(() => expect(statuses.at(-1)).toContain("CLA 80%/-"));
    await commands.get("quota-console")?.("", ctx);
    const url = notices.find((item) => item.includes("http://127.0.0.1:"))?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    await fire("before_provider_headers");
    await fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now(), stopReason: "stop",
      usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } } });
    await writeFile(authPath, JSON.stringify(login("oauth-b")));
    await fire("model_select", { model: { provider: "anthropic" } });
    // A previous account must disappear even while its replacement query is pending.
    expect(statuses.at(-1)).toContain("CLA -/-");
    await vi.waitFor(() => expect(statuses.at(-1)).toContain("CLA 20%/-"));
    const state = await (await fetch(`${url}/api/state`)).json();
    expect(state.claude.value.fiveHour.remainingPercent).toBe(20);
    const entries = await readdir(join(dir, "pi-quota-monitor", "usage"));
    const content = (await Promise.all(entries.filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(join(dir, "pi-quota-monitor", "usage", name), "utf8")))).join("");
    expect(JSON.parse(content.trim()).accountId).toBe("identity-a");
    expect(JSON.stringify(state)).not.toContain("oauth-a");
    expect(JSON.stringify(state)).not.toContain("oauth-b");
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-api" } }));
    await fire("model_select", { model: { provider: "anthropic" } });
    expect(statuses.at(-1)).toContain("CLA -/-");
    expect(vi.mocked(queryClaudeQuota).mock.calls.map(([access]) => access)).not.toContain("sk-api");
  } finally { await fire("session_shutdown", { reason: "quit" }); }
});
