import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountDisplayName, accountIdentities, activeAccountId, credential, deleteAccount, importAccount, listAccounts, listAllAccounts,
  rememberAccount, resolveCredentialAccount, saveAccount, setAccountNote, useAccount } from "../src/accounts.js";
import { accountKey, accountViewId, type AccountProvider, type UsageScope } from "../src/account-identity.js";
import { parseClaudeIdentity } from "../src/providers/claude.js";
import { grokAccountId } from "../src/providers/grok.js";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { appendUsage, localDate, readDailyUsage } from "../src/tokens/store.js";
import { backupHistory, deleteModelUsage, importHistory, resetAccountUsage } from "../src/history.js";
import { QuotaReadings } from "../src/quota-readings.js";
import quotaMonitor from "../src/index.js";
import type { TokenUsageRecord } from "../src/types.js";

vi.mock("../src/config.js", async (load) => {
  const original = await load<typeof import("../src/config.js")>();
  return { ...original, loadConfig: async () => ({ ...original.DEFAULT_CONFIG, dashboardPort: 0 }) };
});
const previous = process.env.PI_CODING_AGENT_DIR;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const oauth = (access: string, accountId?: string) => ({ type: "oauth", access, refresh: `private-refresh-${access}`, expires: Date.now() + 3_600_000, ...(accountId ? { accountId } : {}) });
const codex = (id = "codex-a", email = "shared@example.com") => oauth(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: id }, "https://api.openai.com/profile": { email } }), id);
const grok = (team = "team-a") => oauth(jwt({ sub: "grok-user", team_id: team, email: "shared@example.com" }));
const profile = (user = "claude-user", org = "org-a", email = "shared@example.com") => ({ account: { uuid: user, email }, organization: { uuid: org, name: org, subscription_type: "max" } });
async function setup(auth: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), "quota-multi-")); directories.push(dir); process.env.PI_CODING_AGENT_DIR = dir;
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return { dir, root: join(dir, "pi-quota-monitor"), authPath: join(dir, "auth.json") };
}
function mockProviders() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url), bearer = new Headers(init?.headers).get("Authorization");
    if (path.endsWith("/profile")) return new Response(JSON.stringify(profile("claude-user", bearer?.includes("claude-b") ? "org-b" : "org-a")));
    if (path.endsWith("/usage") && path.includes("anthropic")) return new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() } }));
    if (path.endsWith("/wham/usage")) return new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } }));
    if (path.includes("/v1/billing")) return new Response(JSON.stringify({ config: { creditUsagePercent: 5, billingPeriodEnd: new Date(Date.now() + 86_400_000).toISOString() } }));
    if (path.includes("/v1/settings")) return new Response(JSON.stringify({ subscription_tier_display: "SuperGrok" }));
    throw new Error("Unexpected test endpoint");
  });
}
const row = (provider: string, accountId?: string, extra: Partial<TokenUsageRecord> = {}): TokenUsageRecord => ({ timestamp: Date.now() - 1000,
  provider, model: provider === "anthropic" ? "claude-sonnet-4-6" : provider === "xai" ? "grok-4.3" : "gpt-6-sol",
  input: 10, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 12, ...(accountId ? { accountId } : {}), ...extra });

it("uses stable provider/organization identities, with note > email > short ID and no secret metadata", async () => {
  const { root, authPath } = await setup({ "openai-codex": codex(), anthropic: oauth("opaque-claude-a"), xai: grok() });
  mockProviders();
  await Promise.all([saveAccount("same", "openai-codex"), saveAccount("same", "anthropic"), saveAccount("same", "xai")]);
  const accounts = (await listAllAccounts()).accounts;
  expect(accounts).toHaveLength(3);
  expect(new Set(accounts.map((a) => a.key)).size).toBe(3);
  expect(accounts.map(accountDisplayName)).toEqual(["shared@example.com", "shared@example.com", "shared@example.com"]);
  const claude = accounts.find((a) => a.provider === "anthropic")!;
  await setAccountNote("anthropic", claude.accountId, "工作号");
  await writeFile(authPath, JSON.stringify({ anthropic: oauth("opaque-claude-a-refreshed") }));
  const refreshed = await resolveCredentialAccount("anthropic", credential(readStoredCredential("anthropic"), "anthropic"));
  expect(refreshed.key).toBe(claude.key); expect(accountDisplayName(refreshed)).toBe("工作号");
  await setAccountNote("anthropic", claude.accountId, "");
  expect(accountDisplayName(accountIdentities().find((a) => a.key === claude.key)!)).toBe("shared@example.com");
  const noEmail = await rememberAccount("openai-codex", "without-email");
  expect(accountDisplayName(noEmail)).toBe(`账号 ${noEmail.key.slice(0, 8)}`);
  expect(parseClaudeIdentity(profile("claude-user", "org-b"))).not.toBe(claude.accountId);
  expect(grokAccountId(grok("team-b").access)).not.toBe(grokAccountId(grok().access));
  const text = await readFile(join(root, "account-identities.json"), "utf8");
  expect(text).not.toContain("opaque-claude-a"); expect(text).not.toContain("private-refresh");
  expect((await stat(join(root, "account-identities.json"))).mode & 0o777).toBe(0o600);
  await expect(setAccountNote("anthropic", claude.accountId, "bad\nremark")).rejects.toThrow("control characters");
});

it("switches only the requested provider and synchronizes refreshed credentials across aliases", async () => {
  const { dir, authPath } = await setup({ "openai-codex": codex(), anthropic: oauth("opaque-claude-a"), xai: grok() });
  mockProviders();
  await saveAccount("work", "anthropic"); await saveAccount("alias", "anthropic"); await saveAccount("work", "openai-codex"); await saveAccount("work", "xai");
  const file = join(dir, "claude-b.json"); await writeFile(file, JSON.stringify(oauth("opaque-claude-b")));
  await importAccount("backup", file, "anthropic");
  const original = JSON.parse(await readFile(authPath, "utf8"));
  const refreshed = { ...original, anthropic: oauth("opaque-claude-a-refreshed") };
  await writeFile(authPath, JSON.stringify(refreshed));
  await resolveCredentialAccount("anthropic", credential(refreshed.anthropic, "anthropic"));
  await useAccount("backup", "anthropic");
  const switched = JSON.parse(await readFile(authPath, "utf8"));
  expect(switched["openai-codex"]).toEqual(original["openai-codex"]); expect(switched.xai).toEqual(original.xai);
  for (const label of ["work", "alias"]) expect((await readFile(join(dir, "pi-quota-monitor", "accounts", "anthropic", `${label}.json`), "utf8"))).toContain("opaque-claude-a-refreshed");
  expect((await listAccounts("anthropic")).current).toBe("backup");
  await deleteAccount("work", "anthropic");
  expect(accountIdentities().some((a) => a.provider === "anthropic" && a.accountId === parseClaudeIdentity(profile()))).toBe(true);
  await useAccount("alias", "anthropic");
  const restored = readStoredCredential("anthropic");
  expect(restored?.type === "oauth" && restored.access).toBe("opaque-claude-a-refreshed");
});

it("keeps OAuth account totals, other sources and unassigned usage disjoint across every scope", async () => {
  await setup();
  const records = [row("openai-codex", "same-id"), row("openai-codex", "b"), row("anthropic", "same-id"), row("xai", "d"),
    row("antigravity"), row("anthropic", undefined, { authType: "api-key" }), row("anthropic"), row("subagent-unattributed", undefined, { model: "unknown-subagent" }),
    row("anthropic", "same-id", { authType: "unknown", accountKey: accountKey("anthropic", "same-id") })];
  for (const r of records) await appendUsage(r);
  const scopes: UsageScope[] = [{ type: "account", provider: "openai-codex", accountId: "same-id" }, { type: "account", provider: "openai-codex", accountId: "b" },
    { type: "account", provider: "anthropic", accountId: "same-id" }, { type: "account", provider: "xai", accountId: "d" }, { type: "other" }, { type: "unassigned" }];
  const parts = await Promise.all(scopes.map(async (s) => { const a = new UsageAggregator(undefined, s); await a.refresh(); return a.state(); }));
  expect(parts.map((s) => s.records)).toEqual([1, 1, 1, 1, 2, 3]);
  const all = new UsageAggregator(); await all.refresh();
  expect(parts.reduce((n, s) => n + s.totals.totalTokens, 0)).toBe(all.state().totals.totalTokens);
  expect(parts.reduce((n, s) => n + s.pricing.estimatedCostUsd, 0)).toBeCloseTo(all.state().pricing.estimatedCostUsd);
  for (let i = 0; i < scopes.length; i++) expect((await readDailyUsage(localDate(Date.now()), scopes[i])).totalTokens).toBe(parts[i].totals.totalTokens);
  const claude = new UsageAggregator(undefined, { type: "provider", provider: "anthropic" }); await claude.refresh(); expect(claude.state().records).toBe(4);
});

it("deletes and resets only the specified provider/account and automatically backs up without credentials", async () => {
  await setup({ "openai-codex": codex() }); await saveAccount("work");
  for (const r of [row("openai-codex", "same"), row("anthropic", "same"), row("anthropic", "other"), row("antigravity")]) await appendUsage(r);
  const removed = await deleteModelUsage("anthropic", "claude-sonnet-4-6", { type: "account", provider: "anthropic", accountId: "same" });
  expect(removed.removed).toBe(1);
  const backup = JSON.parse(await readFile(removed.backup!, "utf8")); expect(backup.profiles).toEqual([]);
  expect(JSON.stringify(backup)).not.toContain("private-refresh");
  const all = new UsageAggregator(); await all.refresh(); expect(all.state().records).toBe(3);
  expect((await resetAccountUsage("other", "anthropic")).removed).toBe(1);
  await all.refresh(); expect(all.state().models.map((r) => r.provider).sort()).toEqual(["antigravity", "openai-codex"]);
});

it("restores multi-provider profiles with identical names, remarks and unchanged ledger contents", async () => {
  await setup({ "openai-codex": codex(), anthropic: oauth("opaque-claude-a"), xai: grok() }); mockProviders();
  for (const p of ["openai-codex", "anthropic", "xai"] as const) { await saveAccount("same", p); await appendUsage(row(p, activeAccountId(p))); }
  const id = activeAccountId("anthropic")!; await setAccountNote("anthropic", id, "工作订阅");
  const path = await backupHistory();
  await setup();
  expect(await importHistory(path)).toEqual({ profiles: 3, records: 3 });
  expect(await importHistory(path)).toEqual({ profiles: 0, records: 0 });
  expect((await listAllAccounts()).profiles).toHaveLength(3);
  expect(accountDisplayName(accountIdentities().find((a) => a.provider === "anthropic")!)).toBe("工作订阅");
  const all = new UsageAggregator(); await all.refresh(); expect(all.state().totals.totalTokens).toBe(36);
});

it("refuses forged identity claims, unknown Claude identities and damaged-profile overwrite", async () => {
  const { dir, root } = await setup({ "openai-codex": { ...codex("actual"), accountId: "wrong" } });
  await expect(saveAccount("forged")).rejects.toThrow("identify");
  const source = join(dir, "unknown.json"); await writeFile(source, JSON.stringify(oauth("opaque-unknown")));
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ account: {}, organization: {} })));
  await expect(importAccount("unknown", source, "anthropic")).rejects.toThrow("identify");
  expect(fetcher).toHaveBeenCalledOnce();
  await writeFile(join(root, "accounts", "anthropic", "damaged.json"), "{damaged}");
  await expect(importAccount("damaged", source, "anthropic")).rejects.toThrow("will not overwrite");
  expect(await readFile(join(root, "accounts", "anthropic", "damaged.json"), "utf8")).toBe("{damaged}");
});

it("can activate an imported account when auth.json does not yet exist", async () => {
  const { dir, authPath } = await setup();
  const path = join(dir, "native.json"); await writeFile(path, JSON.stringify(codex()));
  await importAccount("first", path); await rm(authPath);
  const rollback = await useAccount("first");
  expect(activeAccountId()).toBe("codex-a");
  expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  await rollback(); expect(readStoredCredential("openai-codex")).toBeUndefined();
});

it("backs up refreshed aliases and refuses to overwrite a damaged profile during restore", async () => {
  const { root, authPath } = await setup({ "openai-codex": codex() });
  await saveAccount("work"); await saveAccount("alias");
  const refreshed = { ...codex(), refresh: "new-refresh" }; await writeFile(authPath, JSON.stringify({ "openai-codex": refreshed }));
  await appendUsage(row("openai-codex", "codex-a"));
  const path = await backupHistory(), backup = JSON.parse(await readFile(path, "utf8"));
  expect(backup.profiles.map((p: any) => p.credential.refresh)).toEqual(["new-refresh", "new-refresh"]);
  const damaged = join(root, "accounts", "work.json"); await writeFile(damaged, "{damaged}");
  await expect(importHistory(path)).rejects.toThrow("Profile path conflict");
  expect(await readFile(damaged, "utf8")).toBe("{damaged}");
  const all = new UsageAggregator(); await all.refresh(); expect(all.state().records).toBe(1);
});

async function harness(provider: AccountProvider = "anthropic") {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>(), commands = new Map<string, (args: string, ctx: any) => unknown>();
  const notices: string[] = [], entries: object[] = [], setModel = vi.fn(), newSession = vi.fn();
  quotaMonitor({ on(name: string, fn: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, fn); return () => {}; },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => unknown }) { commands.set(name, options.handler); },
    appendEntry: (customType: string, data: object) => entries.push({ type: "custom", customType, data }), setModel,
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, mode: "rpc", model: { provider, id: "unchanged-model" }, waitForIdle: vi.fn(async () => {}), hasPendingMessages: () => false,
    newSession, ui: { setStatus() {}, confirm: async () => true, notify: (text: string) => notices.push(text) },
    sessionManager: { getBranch: () => [], getSessionId: () => "main-test-session" },
    modelRegistry: { getProvider: (p: string) => ({ baseUrl: p === "anthropic" ? "https://api.anthropic.com" : p === "xai" ? "https://api.x.ai" : "https://chatgpt.com/backend-api" }),
      getProviderAuth: vi.fn(async (p: string) => { const c = readStoredCredential(p); return c?.type === "oauth" ? { auth: { apiKey: c.access } } : undefined; }), getApiKeyForProvider: async () => undefined },
  } as unknown as ExtensionContext;
  const fire = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, fire, commands, notices, entries, setModel, newSession };
}

it("switches Claude without model/session changes, and rolls back a mismatched runtime credential", async () => {
  const { dir } = await setup({ anthropic: oauth("opaque-claude-a"), "openai-codex": codex() }); mockProviders();
  await saveAccount("a", "anthropic"); const source = join(dir, "b.json"); await writeFile(source, JSON.stringify(oauth("opaque-claude-b"))); await importAccount("b", source, "anthropic");
  const h = await harness("openai-codex");
  await h.commands.get("quota-account-use")!("anthropic b", h.ctx);
  expect(activeAccountId("anthropic")).toBe(parseClaudeIdentity(profile("claude-user", "org-b")));
  expect(h.ctx.model?.id).toBe("unchanged-model"); expect(h.setModel).not.toHaveBeenCalled(); expect(h.newSession).not.toHaveBeenCalled();
  expect(h.notices.at(-1)).toContain("已切换 Claude");
  vi.mocked(h.ctx.modelRegistry.getProviderAuth).mockResolvedValue({ auth: { apiKey: "runtime-override" } } as any);
  await h.commands.get("quota-account-use")!("anthropic a", h.ctx);
  expect(activeAccountId("anthropic")).toBe(parseClaudeIdentity(profile("claude-user", "org-b")));
  expect(h.notices.at(-1)).toContain("rolled back");
});

it("rolls back an attempted first provider login without changing another provider", async () => {
  const { dir, authPath } = await setup({ "openai-codex": codex() }); mockProviders();
  const originalCodex = readStoredCredential("openai-codex");
  const source = join(dir, "claude.json"); await writeFile(source, JSON.stringify(oauth("opaque-claude-a"))); await importAccount("a", source, "anthropic");
  const h = await harness(); vi.mocked(h.ctx.modelRegistry.getProviderAuth).mockResolvedValue(undefined);
  await h.commands.get("quota-account-use")!("anthropic a", h.ctx);
  const auth = JSON.parse(await readFile(authPath, "utf8")); expect(auth.anthropic).toBeUndefined(); expect(auth["openai-codex"]).toEqual(originalCodex);
  expect(h.notices.at(-1)).toContain("rolled back");
});

it("captures actual request auth, never attributes override/unknown headers to the stored OAuth", async () => {
  const { root, authPath } = await setup({ anthropic: oauth("opaque-claude-a") }); mockProviders();
  const h = await harness(); await h.fire("session_start");
  try {
    await h.fire("before_provider_headers", { headers: { Authorization: "Bearer opaque-claude-a" } });
    await h.fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now(), stopReason: "stop", usage: row("anthropic") } });
    await h.fire("before_provider_headers", { headers: { "x-api-key": "runtime-override" } });
    await h.fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now() + 1, stopReason: "stop", usage: row("anthropic") } });
    const headers = { Authorization: "Bearer opaque-claude-a" };
    await h.fire("before_provider_headers", { headers });
    headers.Authorization = "Bearer later-extension-override";
    await h.fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now() + 2, stopReason: "stop", usage: row("anthropic") } });
    await h.fire("before_provider_headers", { headers: { Authorization: "Bearer opaque-claude-a" } });
    await writeFile(authPath, JSON.stringify({ anthropic: oauth("opaque-claude-b") }));
    await h.fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now() + 3, stopReason: "stop", usage: row("anthropic") } });
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "native-api-key" } }));
    await h.fire("before_provider_headers", { headers: { "x-api-key": "native-api-key" } });
    await h.fire("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: Date.now() + 4, stopReason: "stop", usage: row("anthropic") } });
    await h.fire("session_shutdown");
    const text = await readFile(join(root, "usage", `usage-${localDate(Date.now())}.jsonl`), "utf8");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((r) => r.accountId)).toEqual([parseClaudeIdentity(profile()), undefined, undefined, parseClaudeIdentity(profile()), undefined]);
    expect(rows.map((r) => r.authType)).toEqual(["oauth", "unknown", "unknown", "oauth", "api-key"]);
    expect(rows.reduce((n, r) => n + r.totalTokens, 0)).toBe(60);
    expect(text).not.toContain("opaque-claude-a"); expect(text).not.toContain("shared@example.com");
    expect(h.entries).toHaveLength(5);
    expect(h.entries.map((e: any) => e.data.timestamp)).toEqual(rows.map((r) => r.timestamp));
  } finally { await h.fire("session_shutdown"); }
});

it("does not claim Codex accounts from conflicting auth/scope headers or a stale agent request", async () => {
  const { root } = await setup({ "openai-codex": codex() }); mockProviders();
  const h = await harness("openai-codex"), access = codex().access, timestamp = Date.now();
  await h.fire("session_start");
  const end = (offset: number) => h.fire("message_end", { message: { role: "assistant", provider: "openai-codex", model: "gpt-6-sol",
    timestamp: timestamp + offset, stopReason: "stop", usage: row("openai-codex") } });
  try {
    for (const [i, headers] of [
      { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": "codex-a" },
      { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": "another-account" },
      { Authorization: `Bearer ${access}`, authorization: `Bearer ${access}` },
      { Authorization: `Bearer ${access}`, "x-api-key": "conflicting-key" },
    ].entries()) { await h.fire("before_provider_headers", { headers }); await end(i); }
    const headers = { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": "codex-a" };
    await h.fire("before_provider_headers", { headers }); headers["ChatGPT-Account-Id"] = "another-account"; await end(4);
    await h.fire("before_provider_headers", { headers: { Authorization: `Bearer ${access}` } }); await h.fire("agent_start"); await end(5);
    await h.fire("session_shutdown");
    const text = await readFile(join(root, "usage", `usage-${localDate(timestamp)}.jsonl`), "utf8");
    const records = text.trim().split("\n").map((r) => JSON.parse(r));
    expect(records.map((r) => r.accountId)).toEqual(["codex-a", undefined, undefined, undefined, undefined, undefined]);
    expect(records.reduce((sum, r) => sum + r.totalTokens, 0)).toBe(72);
  } finally { await h.fire("session_shutdown"); }
});

it("keeps quota ownership consistent when login changes while the dashboard is building account views", async () => {
  const { dir, authPath } = await setup({ anthropic: oauth("opaque-claude-a") });
  const realFetch = globalThis.fetch; mockProviders();
  await saveAccount("work", "anthropic");
  const source = join(dir, "backup.json"); await writeFile(source, JSON.stringify(oauth("opaque-claude-b"))); await importAccount("backup", source, "anthropic");
  const b = parseClaudeIdentity(profile("claude-user", "org-b"))!; await setAccountNote("anthropic", b, "备用订阅");
  const h = await harness(); await h.fire("session_start");
  try {
    await h.commands.get("quota-console")!("", h.ctx);
    const url = h.notices.find((n) => /http:\/\/127/.test(n))?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; expect(url).toBeDefined();
    await (await realFetch(`${url}/api/state`)).json();
    const originalList = listAllAccounts;
    vi.spyOn(await import("../src/accounts.js"), "listAllAccounts").mockImplementationOnce(async () => {
      const listed = await originalList(); // Captured account A; then another process logs in as B.
      await writeFile(authPath, JSON.stringify({ anthropic: oauth("opaque-claude-b") }));
      await h.commands.get("quota-refresh")!("", h.ctx);
      return listed;
    });
    const state = await (await realFetch(`${url}/api/state`)).json();
    expect(state.currentAccounts.anthropic.id).toBe(accountViewId("anthropic", b));
    expect(state.quotaAccounts.anthropic.name).toContain("备用订阅");
    expect(state.claude.value).toBeDefined();
    expect(state.profiles.find((p: any) => p.name === "backup").current).toBe(true);
    expect(state.profiles.find((p: any) => p.name === "work").current).toBe(false);
  } finally { await h.fire("session_shutdown"); }
});

it("keeps historical accounts discoverable without rewriting old ledgers and never switches for quota views", async () => {
  const { root } = await setup({ "openai-codex": codex() });
  const originalCodex = readStoredCredential("openai-codex");
  await saveAccount("work"); await rememberAccount("anthropic", "historical", { note: "旧订阅" });
  const record = row("anthropic", "historical"); await appendUsage(record);
  const path = join(root, "usage", `usage-${localDate(Date.now())}.jsonl`), original = await readFile(path, "utf8");
  const capturedAt = Date.now() - 86_400_000;
  await new QuotaReadings("claude", "historical").append({ capturedAt, fiveHour: { label: "5h", remainingPercent: 45 } });
  const realFetch = globalThis.fetch; mockProviders();
  const h = await harness("openai-codex"); await h.fire("session_start");
  try {
    await h.commands.get("quota-console")!("", h.ctx);
    const url = h.notices.find((n) => /http:\/\/127/.test(n))?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; expect(url).toBeDefined();
    const all = await (await realFetch(`${url}/api/state`)).json(); expect(all.selectedAccountId).toBe("all");
    const state = await (await realFetch(`${url}/api/state?account=${accountViewId("anthropic", "historical")}`)).json();
    expect(state.usage.records).toBe(1); expect(state.claude).toMatchObject({ historical: true, value: { capturedAt } });
    expect(state.quotaAccounts.anthropic.name).toContain("旧订阅");
    expect(readStoredCredential("openai-codex")).toEqual(originalCodex); expect(readStoredCredential("anthropic")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(original);
    expect(JSON.stringify(state)).not.toContain("private-refresh");
  } finally { await h.fire("session_shutdown"); }
});
