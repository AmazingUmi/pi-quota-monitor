import { createHash } from "node:crypto";
import { readStoredCredential, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeAccountId, accountDisplayName, accountIdentities, deleteAccount, importAccount, knownCredentialAccount, listAccounts, listAllAccounts, credential, rememberAccount, resolveCredentialAccount, saveAccount, setAccountNote, useAccount } from "./accounts.js";
import { ACCOUNT_PROVIDERS, PROVIDER_NAMES, accountKey, accountViewId, isAccountProvider, type AccountProvider, type UsageScope } from "./account-identity.js";
import { backupHistory, deleteModelUsage, importHistory, inspectHistory, listBackups, resetAccountUsage } from "./history.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import type { DashboardAccount, DashboardCurrentAccount, DashboardProfile, QuotaDashboard } from "./dashboard.js";
import { attachDashboard, detachDashboard } from "./resident-dashboard.js";
import { QuotaReadings } from "./quota-readings.js";
import { queryAntigravityQuota, queryNativeAntigravityQuota } from "./providers/antigravity.js";
import { queryCodexQuota } from "./providers/codex.js";
import { queryClaudeQuota } from "./providers/claude.js";
import { grokAccountId, queryGrokQuota } from "./providers/grok.js";
import { RefreshScheduler } from "./scheduler.js";
import { formatDetails, formatStatus } from "./statusline.js";
import { UsageAggregator } from "./tokens/aggregate.js";
import { accumulate, emptyTotals, tokenRecord } from "./tokens/collector.js";
import { quotaAmountEstimates } from "./quota-estimate.js";
import { appendUsage, localDate, readDailyUsage } from "./tokens/store.js";
import { subagentUsage } from "./tokens/subagents.js";
import type { AntigravityQuota, CardVisibilitySettings, ClaudeQuota, CodexQuota, GrokQuota, MonitorConfig, ProviderCache, TokenTotals } from "./types.js";

const STATUS_KEY = "pi-quota-monitor";
type ProviderId = "openai-codex" | "anthropic" | "antigravity" | "xai";

function claudeAccess(): string | undefined {
  const stored = readStoredCredential("anthropic");
  return stored?.type === "oauth" && typeof stored.access === "string" && stored.access ? stored.access : undefined;
}
function claudeRevision(): string | undefined {
  const access = claudeAccess();
  return access ? createHash("sha256").update(access).digest("hex") : undefined;
}
function grokAccess(): string | undefined {
  const stored = readStoredCredential("xai");
  return stored?.type === "oauth" && typeof stored.access === "string" && stored.access ? stored.access : undefined;
}
function grokRevision(): string | undefined {
  const access = grokAccess();
  return access ? createHash("sha256").update(access).digest("hex") : undefined;
}

function safeFailure(error: unknown): string {
  // Never display provider response bodies, authorization headers, or error messages containing secrets.
  if (error instanceof Error && ["Codex credential belongs to a custom endpoint.", "Claude credential belongs to a custom endpoint.", "Grok credential belongs to a custom endpoint."].includes(error.message)) return error.message;
  if (error instanceof Error && /credentials unavailable|credential unavailable|Invalid Antigravity provider credential/i.test(error.message)) return "Not logged in";
  if (error instanceof Error && error.message === "agy binary unavailable.") return "agy executable unavailable";
  if (error instanceof Error && error.message === "agy usage timed out.") return "agy native query timed out";
  return "Query failed; retry later";
}

function requestCredential(headers: Record<string, string | null> = {}): string | undefined {
  const entries = Object.entries(headers).filter(([key, value]) => value !== null
    && ["authorization", "x-api-key"].includes(key.toLowerCase()));
  if (entries.length !== 1) return; // Conflicting or duplicate authentication headers cannot prove an account.
  const [key, value] = entries[0];
  return key.toLowerCase() === "authorization" ? /^Bearer\s+(\S+)$/i.exec(value!)?.[1]
    : value && !/\s/.test(value) ? value : undefined;
}
function codexAccountMatches(headers: Record<string, string | null>, id: string): boolean {
  const hints = Object.entries(headers).filter(([key, value]) => value !== null && key.toLowerCase() === "chatgpt-account-id");
  return !hints.length || (hints.length === 1 && hints[0][1] === id);
}
function resolvedAccess(auth?: { apiKey?: string; headers?: Record<string, string | null> }): string | undefined {
  if (!auth) return;
  const explicit = Object.entries(auth.headers ?? {}).some(([key, value]) => value !== null
    && ["authorization", "x-api-key"].includes(key.toLowerCase()));
  return explicit ? requestCredential(auth.headers) : auth.apiKey;
}
function oauthAccessMatches(auth: { apiKey?: string; headers?: Record<string, string | null> }, provider: AccountProvider): boolean {
  const stored = readStoredCredential(provider);
  const access = resolvedAccess(auth);
  if (provider === "openai-codex") {
    const id = activeAccountId(provider);
    if (!id || !codexAccountMatches(auth.headers ?? {}, id)) return false;
  }
  return stored?.type === "oauth" && !!access && access === stored.access;
}
function safeAccountFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    "Only Pi's native Codex OAuth profiles with accountId are supported.",
    "Only native Pi OAuth profiles are supported.", "Unable to identify this OAuth account.",
    "Account note must be at most 120 characters without control characters.",
    "Invalid account registry.", "Invalid account profile.", "Profile identity does not match its credential.",
    "Pi did not load the selected OAuth credential; account switch rolled back.",
    "Credential changed externally; rollback was not applied.",
    "Invalid profile name (use letters, digits, dots, underscores or hyphens).",
    "Profile name belongs to another account.",
    "Current profile differs from Pi login; save it before switching.",
    "Save the current Pi account before switching.",
    "Invalid Pi auth.json.",
    "Profile already exists; import will not overwrite it.",
    "Invalid backup.", "Unsupported backup format.", "Invalid backup profile.", "Invalid backup ledger.",
    "Profile name conflict; import aborted.", "Profile path conflict; import aborted.", "An account ID is required.",
    "Ledger contains an incomplete or damaged line; reset aborted without changing usage.",
    "Please clear queued messages before switching.",
    "Pi did not load the selected Codex credential; account switch rolled back.",
    "Unknown account profile.", "Reset requires an interactive confirmation.",
    "Restore requires an interactive confirmation.", "Delete requires an interactive confirmation.",
    "Switch to another account before deleting the active profile.",
    "Backup directory must be an absolute path on the Pi machine.",
    "Backup directory must be an existing private directory (0700).",
  ];
  return allowed.includes(message) ? message : "账号操作失败；请检查本地文件、权限及账号状态。";
}

function contextMetrics(ctx: ExtensionContext): { tokens: number | null; contextWindow: number; percent: number | null } | null {
  const usage = ctx.getContextUsage?.();
  return usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? { contextWindow: usage.contextWindow,
      tokens: usage.tokens !== null && Number.isFinite(usage.tokens) ? usage.tokens : null,
      percent: usage.percent !== null && Number.isFinite(usage.percent) ? usage.percent : null }
    : null;
}

function branchTotals(ctx: ExtensionContext): TokenTotals {
  return ctx.sessionManager.getBranch().reduce((totals, entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return totals;
    const record = tokenRecord(entry.message);
    return record ? accumulate(totals, record) : totals;
  }, emptyTotals());
}

export default function quotaMonitor(pi: ExtensionAPI): void {
  const dashboardOwner = {};
  let codexHistory: CodexQuota[] = [];
  let agyHistory: AntigravityQuota[] = [];
  let claudeHistory: ClaudeQuota[] = [];
  let grokHistory: GrokQuota[] = [];
  const agyReadings = new QuotaReadings("antigravity");
  let readingsQueue: Promise<void> = Promise.resolve();
  let codexRestore: Promise<void> = Promise.resolve();
  let active = false;
  let generation = 0;
  let config: MonitorConfig = { ...DEFAULT_CONFIG };
  let scheduler: RefreshScheduler | undefined;
  let dashboard: QuotaDashboard | undefined;
  let accountAggregators: UsageAggregator[] = [];
  const views = new Map<string, UsageAggregator>();
  let accountNotice: { message: string; level: "info" | "warning" | "error"; at: number } | undefined;
  let abortController: AbortController | undefined;
  let currentContext: ExtensionContext | undefined;
  let sessionTotals = emptyTotals();
  let dailyTotals = emptyTotals();
  let dailyDate = "";
  let ledgerQueue: Promise<void> = Promise.resolve();
  let childUsage: ReturnType<typeof subagentUsage> | undefined;
  let childUsageIncomplete = false;
  const reconcileChildren = () => { void childUsage?.reconcile(); }; // Children prove their own identities; never pass the parent's login.
  const requestAccounts = new Map<AccountProvider, { accountId?: string; authType: "oauth" | "api-key" | "unknown";
    access?: string; headers: Record<string, string | null> }>();
  let claudeAccountId: string | undefined;
  let grokAccount: string | undefined;
  let lastClaudeRevision: string | undefined;
  let lastGrokRevision: string | undefined;
  let codexAccountId: string | undefined;
  const codex: ProviderCache<CodexQuota> = {};
  const antigravity: ProviderCache<AntigravityQuota> = {};
  const claude: ProviderCache<ClaudeQuota> = {};
  const grok: ProviderCache<GrokQuota> = {};
  const inFlight: Partial<Record<ProviderId, Promise<void>>> = {};

  function live(epoch: number): boolean {
    return active && generation === epoch && !abortController?.signal.aborted;
  }

  function render(ctx: ExtensionContext): void {
    if (!active || !ctx.hasUI) return;
    // RPC setStatus is forwarded by pi-web; TUI uses its native status footer.
    try {
      syncClaudeCredential();
      syncGrokCredential();
      const visibility = ctx.mode === "rpc"
        ? { showOai: config.showOaiInStatusbar, showAgy: config.showAgyInStatusbar, showClaude: config.showClaudeInStatusbar, showGrok: config.showGrokInStatusbar }
        : undefined; // TUI retains all provider status segments.
      ctx.ui.setStatus(STATUS_KEY, formatStatus(codex, antigravity, sessionTotals, config.showReset, Date.now(), visibility, claude, grok));
    } catch {
      // A closing/replaced UI must not turn a completed quota query into an unhandled rejection.
    }
  }

  function syncClaudeCredential(): void {
    const revision = claudeRevision();
    if (revision === lastClaudeRevision) return;
    lastClaudeRevision = revision;
    claudeAccountId = activeAccountId("anthropic");
    claudeHistory = [];
    claude.value = undefined;
    claude.error = undefined;
    claude.restored = false;
    claude.storageError = undefined;
    claude.lastAttemptAt = undefined;
    if (active) void restoreClaude(generation, revision);
  }

  async function restoreClaude(epoch: number, revision: string | undefined): Promise<void> {
    const id = activeAccountId("anthropic");
    const readings = id ? await new QuotaReadings("claude", id).load() : [];
    if (!live(epoch) || claudeRevision() !== revision || claude.value) return;
    claudeHistory = readings;
    if (readings.length) { claude.value = readings.at(-1); claude.restored = true; }
  }

  function syncGrokCredential(): void {
    const revision = grokRevision();
    if (revision === lastGrokRevision) return;
    lastGrokRevision = revision;
    grokAccount = activeAccountId("xai");
    grokHistory = [];
    grok.value = undefined;
    grok.error = undefined;
    grok.restored = false;
    grok.storageError = undefined;
    grok.lastAttemptAt = undefined;
    if (active) void restoreGrok(generation);
  }

  async function restoreGrok(epoch: number): Promise<void> {
    const revision = lastGrokRevision;
    const accountId = grokAccountId(grokAccess() ?? "");
    const readings = accountId ? await new QuotaReadings("grok", accountId).load() : [];
    if (!live(epoch) || grokRevision() !== revision) return;
    grokAccount = accountId;
    grokHistory = readings;
    if (!grok.value && readings.length) { grok.value = readings.at(-1); grok.restored = true; }
  }

  async function restoreCodex(account: string | undefined, epoch: number): Promise<void> {
    const readings = account ? await new QuotaReadings("codex", account).load() : [];
    if (!live(epoch) || codexAccountId !== account || activeAccountId() !== account) return;
    codexHistory = readings;
    if (!codex.value && readings.length) { codex.value = readings.at(-1); codex.restored = true; }
  }

  function persistReading(write: () => Promise<void>, cache: ProviderCache<unknown>, epoch: number): Promise<void> {
    cache.storageError = undefined;
    const value = cache.value;
    readingsQueue = readingsQueue.then(write).catch(() => {
      if (live(epoch) && cache.value === value) cache.storageError = "读数保存失败；当前显示内存读数。";
    });
    return readingsQueue;
  }

  function refresh(provider: ProviderId, ctx: ExtensionContext, force = false): Promise<void> {
    if (!active) return Promise.resolve();
    if (provider === "anthropic") syncClaudeCredential();
    if (provider === "xai") syncGrokCredential();
    const revision = provider === "anthropic" ? lastClaudeRevision : provider === "xai" ? lastGrokRevision : undefined;
    const account = provider === "openai-codex" ? activeAccountId() : undefined;
    if (provider === "openai-codex" && codexAccountId !== account) {
      codexAccountId = account;
      dailyDate = "";
      void updateDailyDate(generation);
      codex.value = undefined;
      codex.error = undefined;
      codex.restored = false;
      codex.storageError = undefined;
      codex.lastAttemptAt = undefined;
      codexHistory = [];
      codexRestore = restoreCodex(account, generation);
      render(ctx);
    }
    if (inFlight[provider]) return inFlight[provider];
    const cache = provider === "openai-codex" ? codex : provider === "anthropic" ? claude : provider === "xai" ? grok : antigravity;
    if (!force && cache.lastAttemptAt !== undefined && Date.now() - cache.lastAttemptAt < config.staleAfterSeconds * 1000) return Promise.resolve();
    cache.lastAttemptAt = Date.now();
    const epoch = generation;
    const signal = abortController!.signal;
    const timeoutMs = config.requestTimeoutSeconds * 1000;
    const promise = (async () => {
      try {
        if (provider === "openai-codex") {
          await codexRestore;
          if (!live(epoch) || activeAccountId() !== account) return;
          const configured = ctx.modelRegistry.getProvider(provider);
          const baseUrl = configured?.baseUrl ?? configured?.getModels()[0]?.baseUrl;
          if (!baseUrl || new URL(baseUrl).origin !== "https://chatgpt.com") {
            throw new Error("Codex credential belongs to a custom endpoint.");
          }
          const resolved = await ctx.modelRegistry.getProviderAuth(provider);
          if (!live(epoch)) return;
          if (!resolved || !oauthAccessMatches(resolved.auth, "openai-codex")) throw new Error("Codex credentials unavailable");
          const result = await queryCodexQuota({ ...resolved.auth, headers: { ...resolved.auth.headers,
            ...(account ? { "ChatGPT-Account-Id": account } : {}) } }, signal, timeoutMs);
          if (!live(epoch) || activeAccountId() !== account) return;
          codex.value = result;
          codex.error = undefined;
          codex.restored = false;
          codexHistory = [...codexHistory.filter((q) => q.capturedAt > Date.now() - 8 * 86_400_000), result];
          if (account) await rememberAccount("openai-codex", account, { plan: result.plan }, resolvedAccess(resolved.auth));
          if (account) await persistReading(() => new QuotaReadings("codex", account).append(result), codex, epoch);
        } else if (provider === "anthropic") {
          if (!revision) throw new Error("Claude OAuth credential unavailable.");
          const configured = ctx.modelRegistry.getProvider(provider);
          if (!configured || new URL(configured.baseUrl ?? configured.getModels()[0]?.baseUrl ?? "").origin !== "https://api.anthropic.com")
            throw new Error("Claude credential belongs to a custom endpoint.");
          const resolved = await ctx.modelRegistry.getProviderAuth(provider);
          const access = claudeAccess();
          if (!live(epoch) || claudeRevision() !== revision) return;
          // An environment API key or custom auth must never be sent to the subscription endpoint.
          if (!access || !resolved || resolved.auth.apiKey !== access) throw new Error("Claude OAuth credential unavailable.");
          const result = await queryClaudeQuota(access, signal, timeoutMs);
          if (!live(epoch) || claudeRevision() !== revision) return;
          if (result.accountId) await rememberAccount("anthropic", result.accountId, result, access);
          if (!live(epoch) || claudeRevision() !== revision) return;
          claudeAccountId = result.accountId;
          claude.value = result.quota;
          claude.error = undefined;
          claude.restored = false;
          claudeHistory = result.accountId ? await new QuotaReadings("claude", result.accountId).load() : [];
          if (!live(epoch) || claudeRevision() !== revision) return;
          claudeHistory = [...claudeHistory.filter((q) => q.capturedAt < result.quota.capturedAt && q.capturedAt > Date.now() - 8 * 86_400_000), result.quota];
          if (result.accountId) await persistReading(() => new QuotaReadings("claude", result.accountId).append(result.quota), claude, epoch);
        } else if (provider === "xai") {
          if (!revision) throw new Error("Grok OAuth credential unavailable.");
          const configured = ctx.modelRegistry.getProvider(provider);
          const baseUrl = configured?.baseUrl ?? configured?.getModels()?.[0]?.baseUrl;
          if (baseUrl && new URL(baseUrl).origin !== "https://api.x.ai") throw new Error("Grok credential belongs to a custom endpoint.");
          const resolved = await ctx.modelRegistry.getProviderAuth(provider);
          const access = grokAccess();
          if (!live(epoch) || grokRevision() !== revision) return;
          // An inference API key must never be sent to the subscription billing host.
          if (!access || !resolved || resolved.auth.apiKey !== access) throw new Error("Grok OAuth credential unavailable.");
          const result = await queryGrokQuota(access, signal, timeoutMs);
          if (!live(epoch) || grokRevision() !== revision) return;
          if (result.accountId) await rememberAccount("xai", result.accountId, { plan: result.quota.plan }, access);
          if (!live(epoch) || grokRevision() !== revision) return;
          grokAccount = result.accountId;
          grok.value = result.quota;
          grok.error = undefined;
          grok.restored = false;
          grokHistory = result.accountId ? await new QuotaReadings("grok", result.accountId).load() : [];
          if (!live(epoch) || grokRevision() !== revision) return;
          grokHistory = [...grokHistory.filter((q) => q.capturedAt < result.quota.capturedAt && q.capturedAt > Date.now() - 8 * 86_400_000), result.quota];
          if (result.accountId) await persistReading(() => new QuotaReadings("grok", result.accountId).append(result.quota), grok, epoch);
        } else {
          const localAgy = ctx.modelRegistry.getProvider(provider)?.baseUrl?.startsWith("agy://") ?? false;
          // Local agy uses a sentinel API key, not an OAuth credential. Its own
          // /usage command reads the logged-in agy session instead.
          const key = localAgy ? undefined : await ctx.modelRegistry.getApiKeyForProvider(provider);
          if (!live(epoch)) return;
          if (!localAgy && !key) throw new Error("Antigravity credential unavailable");
          const result = localAgy || key === "agy-local-session"
            // agy starts a separate backend for /usage; startup + quota refresh can
            // exceed a minute even when the interactive TUI already has data.
            ? await queryNativeAntigravityQuota(signal, Math.max(timeoutMs, 120_000))
            : await queryAntigravityQuota(key!, signal, timeoutMs);
          if (!live(epoch)) return;
          antigravity.value = result;
          antigravity.error = undefined;
          antigravity.restored = false;
          agyHistory = [...agyHistory.filter((q) => q.capturedAt > Date.now() - 8 * 86_400_000), result];
          await persistReading(() => agyReadings.append(result), antigravity, epoch);
        }
      } catch (error) {
        if (!live(epoch) || (provider === "openai-codex" && activeAccountId() !== account)
          || (provider === "anthropic" && claudeRevision() !== revision)
          || (provider === "xai" && grokRevision() !== revision)) return;
        cache.error = safeFailure(error);
      } finally {
        if (live(epoch)) render(ctx);
      }
    })();
    inFlight[provider] = promise;
    void promise.finally(() => {
      if (inFlight[provider] !== promise) return;
      delete inFlight[provider];
      // An account changed during an older query: never reuse its result or delay the new query until the next timer.
      if (live(epoch) && currentContext && (provider === "openai-codex" && activeAccountId() !== account
        || provider === "anthropic" && claudeRevision() !== revision
        || provider === "xai" && grokRevision() !== revision)) {
        void refresh(provider, currentContext, true);
      }
    }).catch(() => {});
    return promise;
  }

  async function refreshAll(ctx: ExtensionContext, force = false): Promise<void> {
    await Promise.all([refresh("openai-codex", ctx, force), refresh("anthropic", ctx, force), refresh("antigravity", ctx, force), refresh("xai", ctx, force)]);
  }

  async function setIntervalSeconds(seconds: number, epoch: number): Promise<void> {
    if (!live(epoch)) throw new Error("Session is no longer active.");
    const next = { ...config, refreshIntervalSeconds: seconds };
    await saveConfig(next);
    if (!live(epoch)) throw new Error("Session is no longer active.");
    config = next;
    scheduler?.updateInterval(seconds * 1000);
    if (currentContext) render(currentContext);
  }

  async function setDashboardPort(port: number, epoch: number): Promise<void> {
    if (!live(epoch)) throw new Error("Session is no longer active.");
    const next = { ...config, dashboardPort: port };
    await saveConfig(next);
    if (!live(epoch)) throw new Error("Session is no longer active.");
    config = next; // The running dashboard keeps its existing socket until the next launch.
  }

  async function setStatusbarSettings(settings: Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showAgyInStatusbar" | "showClaudeInStatusbar" | "showGrokInStatusbar">>, epoch: number): Promise<void> {
    if (!live(epoch)) throw new Error("Session is no longer active.");
    const next = { ...config, ...settings };
    await saveConfig(next);
    if (!live(epoch)) throw new Error("Session is no longer active.");
    config = next;
    if (currentContext) render(currentContext);
  }

  async function setCardSettings(settings: CardVisibilitySettings, epoch: number): Promise<void> {
    if (!live(epoch)) throw new Error("Session is no longer active.");
    const next = { ...config, ...settings };
    await saveConfig(next);
    if (!live(epoch)) throw new Error("Session is no longer active.");
    config = next; // Presentation only: no auth changes, provider refreshes or statusbar changes.
  }

  async function updateDailyDate(epoch: number): Promise<void> {
    await ledgerQueue;
    if (!live(epoch)) return;
    const date = localDate(Date.now());
    if (date === dailyDate) return;
    try {
      const totals = await readDailyUsage(date);
      if (live(epoch)) { dailyDate = date; dailyTotals = totals; }
    } catch { /* Keep the last valid daily result. */ }
  }

  pi.on("session_start", async (_event, ctx) => {
    abortController?.abort();
    scheduler?.stop();
    childUsage?.dispose();
    childUsage = undefined;
    await detachDashboard(dashboardOwner, false);
    dashboard = undefined;
    accountAggregators.forEach((view) => view.stop());
    accountAggregators = [];
    views.clear();
    const epoch = ++generation;
    active = true;
    abortController = new AbortController();
    currentContext = ctx;
    sessionTotals = branchTotals(ctx);
    childUsageIncomplete = false;
    childUsage = pi.events ? subagentUsage(pi, async (records, incomplete) => {
      childUsageIncomplete ||= incomplete;
      for (const record of records) {
        ledgerQueue = ledgerQueue.then(async () => {
          if (await appendUsage(record) && live(epoch)) {
            sessionTotals = accumulate(sessionTotals, record);
            if (localDate(record.timestamp) === dailyDate)
              dailyTotals = accumulate(dailyTotals, record);
          }
        });
      }
      await ledgerQueue;
      if (live(epoch) && currentContext) render(currentContext);
    }) : undefined;
    accountNotice = undefined;
    config = await loadConfig();
    if (!live(epoch)) return;
    delete inFlight["openai-codex"];
    delete inFlight.antigravity;
    delete inFlight.anthropic;
    delete inFlight.xai;
    lastClaudeRevision = undefined;
    lastGrokRevision = undefined;
    claudeAccountId = undefined;
    grokAccount = undefined;
    claudeHistory = [];
    grokHistory = [];
    claude.value = undefined;
    claude.error = undefined;
    claude.lastAttemptAt = undefined;
    claude.storageError = undefined;
    grok.value = undefined;
    grok.error = undefined;
    grok.lastAttemptAt = undefined;
    grok.storageError = undefined;
    syncClaudeCredential();
    syncGrokCredential();
    codexAccountId = activeAccountId();
    requestAccounts.clear();
    codex.value = undefined;
    codex.error = undefined;
    codex.lastAttemptAt = undefined;
    antigravity.value = undefined;
    antigravity.error = undefined;
    antigravity.lastAttemptAt = undefined;
    codex.restored = antigravity.restored = claude.restored = grok.restored = false;
    codex.storageError = antigravity.storageError = undefined;
    await readingsQueue;
    codexRestore = restoreCodex(codexAccountId, epoch);
    const grokRestore = restoreGrok(epoch);
    const restoredAgy = await agyReadings.load();
    await codexRestore;
    await grokRestore;
    if (!live(epoch)) return;
    agyHistory = restoredAgy;
    antigravity.value = agyHistory.at(-1);
    antigravity.restored = !!antigravity.value;
    await ledgerQueue;
    if (!live(epoch)) return;
    dailyDate = localDate(Date.now());
    try { dailyTotals = await readDailyUsage(dailyDate); }
    catch { dailyTotals = emptyTotals(); }
    if (!live(epoch)) return;
    render(ctx);
    scheduler = new RefreshScheduler(config.refreshIntervalSeconds * 1000, () => {
      if (!live(epoch) || !currentContext) return;
      void refreshAll(currentContext);
      void updateDailyDate(epoch);
      render(currentContext); // update reset countdown
    });
    scheduler.start();
    // Start the process-owned console with cached readings; never wait for remote providers.
    await handleQuotaCommand("console", ctx, false);
    void refreshAll(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (!active) return;
    render(ctx);
    if (_event.model.provider === "openai-codex" || _event.model.provider === "anthropic" || _event.model.provider === "antigravity" || _event.model.provider === "xai") {
      void refresh(_event.model.provider, ctx, true);
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (event.status !== 429 || !active) return;
    const provider = ctx.model?.provider;
    if (provider === "openai-codex" || provider === "anthropic" || provider === "antigravity" || provider === "xai") void refresh(provider, ctx, true);
  });

  pi.on("agent_start", () => { requestAccounts.clear(); });

  pi.on("before_provider_headers", async (event, ctx) => {
    const provider = ctx.model?.provider;
    if (!active || !isAccountProvider(provider)) return;
    const epoch = generation;
    if (provider === "anthropic") syncClaudeCredential();
    if (provider === "xai") syncGrokCredential();
    const actual = requestCredential(event.headers);
    const stored = readStoredCredential(provider);
    let id: string | undefined;
    let authType: "oauth" | "api-key" | "unknown" = "unknown";
    if (actual && stored?.type === "oauth" && actual === stored.access) {
      authType = "oauth";
      try {
        const identity = await resolveCredentialAccount(provider, credential(stored, provider), abortController!.signal, config.requestTimeoutSeconds * 1000);
        id = identity.accountId;
        if (provider === "anthropic" && claudeAccess() === actual) claudeAccountId = id;
      } catch { /* Keep the turn unassigned, never infer identity from a model or current quota. */ }
    } else if (actual) {
      // Another process may have switched auth.json after this request resolved its token.
      id = knownCredentialAccount(provider, { type: "oauth", access: actual });
      if (id) authType = "oauth";
      else if (stored?.type === "api_key" && stored.key === actual) authType = "api-key";
    }
    if (provider === "openai-codex" && id && !codexAccountMatches(event.headers, id)) id = undefined;
    if (live(epoch)) requestAccounts.set(provider, { accountId: id, authType, access: actual, headers: event.headers });
  });

  pi.on("message_end", (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    const record = tokenRecord(event.message);
    if (record) {
      record.source = "pi-message";
      record.sessionId = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.();
    }
    if (record && isAccountProvider(record.provider)) {
      const captured = requestAccounts.get(record.provider);
      // Later extensions may mutate the same request headers. Never claim the earlier account if auth changed.
      const unchanged = captured && requestCredential(captured.headers) === captured.access
        && (record.provider !== "openai-codex" || !captured.accountId || codexAccountMatches(captured.headers, captured.accountId));
      record.authType = unchanged ? captured.authType : "unknown";
      if (unchanged && captured.accountId) {
        record.accountId = captured.accountId;
        record.accountKey = accountKey(record.provider, captured.accountId);
      }
      // Timestamped, credential-free receipts let children prove their own turn identity regardless of session-entry order.
      try { pi.appendEntry?.("quota-monitor:request-account", { provider: record.provider, model: record.model,
        timestamp: record.timestamp, accountId: record.accountId, authType: record.authType }); }
      catch { /* Main usage is retained; children without a receipt remain unassigned. */ }
    }
    requestAccounts.clear();
    if (record) {
      sessionTotals = accumulate(sessionTotals, record);
      ledgerQueue = ledgerQueue.then(async () => {
        const appended = await appendUsage(record);
        if (!appended) return;
        const date = localDate(Date.now());
        if (date !== dailyDate) {
          dailyDate = date;
          dailyTotals = await readDailyUsage(date);
        } else {
          dailyTotals = accumulate(dailyTotals, record);
        }
      }).catch(() => {
        // Failed writes must not corrupt the on-screen session count.
      });
      render(ctx);
    }
    if (event.message.stopReason === "error" && /429|quota|rate.limit|RESOURCE_EXHAUSTED/i.test(event.message.errorMessage ?? "")) {
      if (event.message.provider === "openai-codex" || event.message.provider === "anthropic" || event.message.provider === "antigravity" || event.message.provider === "xai") {
        void refresh(event.message.provider, ctx, true);
      }
    } else if (event.message.provider === "openai-codex" || event.message.provider === "anthropic" || event.message.provider === "antigravity" || event.message.provider === "xai") {
      void refresh(event.message.provider, ctx);
    }
  });

  const unsubscribeChildEvents = [
    pi.events?.on("subagents:rpc:v1:ready", reconcileChildren),
    pi.events?.on("subagent:async-complete", reconcileChildren),
    pi.events?.on("subagent:foreground-complete", reconcileChildren),
  ];
  pi.on("agent_settled", reconcileChildren);
  pi.on("tool_result", (event) => { if (event.toolName === "subagent" || event.toolName === "bg_wait") reconcileChildren(); });

  const handleQuotaCommand = async (args: string, ctx: ExtensionContext, announce = true): Promise<void> => {
    if (!active) return;
    const epoch = generation;
    const command = args.trim();
    if (command !== "console") await childUsage?.reconcile();
    // Native /login and external auth changes must invalidate the previous account's quota before display.
    void refresh("openai-codex", ctx);
    void refresh("anthropic", ctx);
    void refresh("xai", ctx);
    if (command === "console") {
      try {
      if (!dashboard) {
        let syncingViews: Promise<{ accounts: DashboardAccount[]; currentAccounts: Partial<Record<AccountProvider, DashboardCurrentAccount>>;
          currentProfile?: string; profiles: DashboardProfile[] }> | undefined;
        const ensureViews = () => {
          if (syncingViews) return syncingViews;
          syncingViews = (async () => {
            if (!live(epoch)) throw new Error("Session is no longer active.");
            let overall = views.get("all");
            if (!overall) {
              overall = new UsageAggregator(); await overall.start();
              if (!live(epoch)) { overall.stop(); throw new Error("Session is no longer active."); }
              views.set("all", overall); accountAggregators.push(overall);
            }
            await overall.refresh();
            for (const a of overall.state().accountScopes ?? []) await rememberAccount(a.provider, a.accountId);
            const listed = await listAllAccounts();
            const specs: Array<{ account: DashboardAccount; scope: UsageScope }> = [
              { account: { id: "all", name: "总体用量" }, scope: { type: "all" } },
              { account: { id: "other", name: "其他来源（agy / API Key 等）" }, scope: { type: "other" } },
              { account: { id: "unassigned", name: "未归属用量" }, scope: { type: "unassigned" } },
            ];
            for (const provider of new Set([...ACCOUNT_PROVIDERS, ...(overall.state().providers ?? [])])) {
              specs.push({ account: { id: `provider:${encodeURIComponent(provider)}`, name: `${isAccountProvider(provider) ? PROVIDER_NAMES[provider] : provider} · 全部用量`, provider }, scope: { type: "provider", provider } });
            }
            const currentAccounts: Partial<Record<AccountProvider, DashboardCurrentAccount>> = {};
            for (const a of listed.accounts.sort((a, b) => ACCOUNT_PROVIDERS.indexOf(a.provider) - ACCOUNT_PROVIDERS.indexOf(b.provider) || accountDisplayName(a).localeCompare(accountDisplayName(b)))) {
              const active = activeAccountId(a.provider) === a.accountId;
              const shortName = accountDisplayName(a);
              const duplicate = listed.accounts.some((b) => b.key !== a.key && b.provider === a.provider && accountDisplayName(b) === shortName);
              const label = `${PROVIDER_NAMES[a.provider]} · ${shortName}${a.organization ? ` · ${a.organization}` : ""}${duplicate ? ` [${a.key.slice(0, 8)}]` : ""}`;
              const id = accountViewId(a.provider, a.accountId);
              specs.push({ account: { id, name: label, provider: a.provider, key: a.key, note: a.note, email: a.email,
                organization: a.organization, plan: a.plan, active }, scope: { type: "account", provider: a.provider, accountId: a.accountId } });
              if (active) currentAccounts[a.provider] = { id, name: label, profile: listed.current[a.provider], current: true };
            }
            const profiles = listed.profiles.map((p) => ({ name: p.name, provider: p.provider, key: p.key,
              displayName: `${specs.find((s) => s.account.key === p.key)?.account.name ?? PROVIDER_NAMES[p.provider]} · profile: ${p.name}`,
              current: activeAccountId(p.provider) === p.accountId }));
            for (const [id, view] of views) {
              if (specs.some((s) => s.account.id === id)) continue;
              view.stop(); views.delete(id); accountAggregators = accountAggregators.filter((item) => item !== view);
            }
            for (const { account, scope } of specs) {
              if (views.has(account.id)) continue;
              const view = new UsageAggregator(undefined, scope);
              await view.start();
              if (!live(epoch)) { view.stop(); throw new Error("Session is no longer active."); }
              views.set(account.id, view); accountAggregators.push(view);
            }
            if (!live(epoch)) throw new Error("Session is no longer active.");
            return { accounts: specs.map((s) => s.account), currentAccounts, currentProfile: listed.current["openai-codex"], profiles };
          })().finally(() => { syncingViews = undefined; });
          return syncingViews;
        };
        // Accept old bookmarked Codex selections without making them global user identities.
        const resolveView = (requested?: string): string | undefined => requested && (views.has(requested) ? requested
          : requested.startsWith("account:") && views.has(accountViewId("openai-codex", requested.slice(8))) ? accountViewId("openai-codex", requested.slice(8)) : undefined);
        try { await ensureViews(); }
        catch { accountAggregators.forEach((view) => view.stop()); accountAggregators = []; views.clear(); throw new Error("Unable to load account usage."); }
        dashboard = await attachDashboard(dashboardOwner, {
          state: async (requested) => {
            await ledgerQueue;
            const listed = await ensureViews();
            const selected = resolveView(requested) ?? "all", view = views.get(selected)!;
            await view.refresh();
            syncClaudeCredential(); syncGrokCredential();
            // Snapshot owner and cache together: login/refresh may change during subsequent disk awaits.
            const nativeIds = Object.fromEntries(ACCOUNT_PROVIDERS.map((p) => [p, activeAccountId(p)])) as Partial<Record<AccountProvider, string>>;
            const currentAccounts = { ...listed.currentAccounts };
            for (const provider of ACCOUNT_PROVIDERS) {
              const nativeId = nativeIds[provider];
              if (!nativeId) { delete currentAccounts[provider]; continue; }
              const id = accountViewId(provider, nativeId);
              if (currentAccounts[provider]?.id === id) continue;
              const a = listed.accounts.find((a) => a.id === id);
              currentAccounts[provider] = { id, name: a?.name ?? `${PROVIDER_NAMES[provider]} · 账号 ${id.slice(8, 16)}`,
                profile: listed.profiles.find((p) => p.provider === provider && p.key === accountKey(provider, nativeId))?.name, current: true };
            }
            const accounts = listed.accounts.map((a) => a.key && isAccountProvider(a.provider)
              ? { ...a, active: a.id === currentAccounts[a.provider]?.id } : a);
            const profiles = listed.profiles.map((p) => ({ ...p, current: !!p.provider && !!p.key && `account:${p.key}` === currentAccounts[p.provider]?.id }));
            const currentProfile = currentAccounts["openai-codex"]?.profile;
            // Quota cards identify their own accounts, independently of the usage filter.
            let visibleCodex: ProviderCache<CodexQuota> = codexAccountId === nativeIds["openai-codex"] ? { ...codex } : {};
            let visibleClaude = claudeAccountId === nativeIds.anthropic ? { ...claude } : {};
            let visibleGrok = grokAccount === nativeIds.xai ? { ...grok } : {};
            let selectedCodexHistory = codexHistory, selectedClaudeHistory = claudeHistory;
            let codexId = nativeIds["openai-codex"], claudeId = claudeAccountId;
            const quotaAccounts = { ...currentAccounts };
            const scope = view.scope;
            if (scope.type === "account" && scope.accountId !== nativeIds[scope.provider]) {
              const a = accounts.find((a) => a.id === selected)!;
              quotaAccounts[scope.provider] = { id: selected, name: a.name, current: false };
              if (scope.provider === "openai-codex") {
                selectedCodexHistory = await new QuotaReadings("codex", scope.accountId).load();
                visibleCodex = { value: selectedCodexHistory.at(-1), restored: true, historical: true }; codexId = scope.accountId;
              } else if (scope.provider === "anthropic") {
                selectedClaudeHistory = await new QuotaReadings("claude", scope.accountId).load();
                visibleClaude = { value: selectedClaudeHistory.at(-1), restored: true, historical: true }; claudeId = scope.accountId;
              } else {
                const readings = await new QuotaReadings("grok", scope.accountId).load();
                visibleGrok = { value: readings.at(-1), restored: true, historical: true };
              }
            }
            const overall = views.get("all")!;
            await overall.refresh();
            const quotaEstimates = quotaAmountEstimates(overall, visibleCodex, antigravity, selectedCodexHistory, agyHistory,
              visibleClaude, selectedClaudeHistory, claudeId, codexId);
            const backups = await listBackups();
            if (!live(epoch)) throw new Error("Session is no longer active.");
            return { accounts, currentProfile, profiles, currentAccounts, quotaAccounts, backups, accountNotice, selectedAccountId: selected,
              currentAccountId: currentAccounts["openai-codex"]?.id, codex: visibleCodex,
              claude: visibleClaude, grok: visibleGrok, antigravity, usage: { ...view.state(), childUsageIncomplete }, context: currentContext ? contextMetrics(currentContext) : null,
              quotaEstimates, config, updatedAt: Date.now() };
          },
          accountCommand: async (command, args) => {
            if (!live(epoch)) throw new Error("Session is no longer active.");
            const name = `quota-account-${command}`;
            if (!accountCommands.some(([registered]) => registered === name)) throw new Error("Unknown account command.");
            pi.sendUserMessage(`/${name}${args ? ` ${args}` : ""}`, {
              expandPromptTemplates: true,
              ...(currentContext?.isIdle?.() === false ? { deliverAs: "followUp" as const } : {}),
            });
          },
          deleteUsage: async (account, provider, model) => {
            if (!live(epoch)) throw new Error("Session is no longer active.");
            await ledgerQueue;
            await ensureViews();
            const resolved = resolveView(account);
            if (!resolved) throw new Error("Unknown ledger view.");
            const view = views.get(resolved)!;
            await view.refresh();
            if (!live(epoch) || !view.state().models.some((item) => item.provider === provider && item.model === model)) {
              throw new Error("Model no longer appears in the selected ledger.");
            }
            const result = await deleteModelUsage(provider, model, view.scope);
            dailyDate = "";
            await updateDailyDate(epoch);
            await Promise.all(accountAggregators.map((item) => item.refresh()));
            return { removed: result.removed };
          },
          refresh: async () => {
            if (!live(epoch) || !currentContext) throw new Error("Session is no longer active.");
            await refreshAll(currentContext, true);
            await updateDailyDate(epoch);
          },
          setInterval: (seconds) => setIntervalSeconds(seconds, epoch),
          setPort: (port) => setDashboardPort(port, epoch),
          setStatusbar: (settings) => setStatusbarSettings(settings, epoch),
          setCards: (settings) => setCardSettings(settings, epoch),
        }, config.dashboardPort);
      }
        const openingDashboard = dashboard;
        const url = await openingDashboard.start(config.dashboardPort);
        if (!live(epoch)) return;
        render(ctx); // Keep this extension's RPC statusbar entry visible according to its settings.
        const notice = openingDashboard.startupNotice;
        const message = `额度控制台：${url}（仅本机访问；Pi 进程内常驻，不随对话切换关闭）${notice ? `\n${notice}` : ""}`;
        if (announce || notice) {
          if (ctx.hasUI) ctx.ui.notify(message, notice ? "warning" : "info");
          else console.log(message);
        }
      } catch (error) {
        if (!live(epoch)) return;
        dashboard = undefined;
        accountAggregators.forEach((view) => view.stop());
        accountAggregators = [];
        views.clear();
        render(ctx);
        const reason = error instanceof Error ? error.message : "未知错误";
        const message = `无法启动本地额度控制台：${reason} 可修改 pi-quota-monitor/config.json 中的 dashboardPort 后重新加载插件。`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(message);
      }
      return;
    }
    if (command === "refresh") {
      await refreshAll(ctx, true);
    } else if (command.startsWith("interval ")) {
      const raw = command.slice("interval ".length).trim();
      const seconds = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
        ctx.ui.notify("Interval must be 60–3600 seconds.", "warning");
        return;
      }
      try { await setIntervalSeconds(seconds, epoch); }
      catch { if (live(epoch)) ctx.ui.notify("Unable to save refresh interval.", "error"); return; }
    } else if (command) {
      ctx.ui.notify("Use /quota, /quota-console, /quota-refresh, or /quota-interval <60-3600>.", "warning");
      return;
    }
    await updateDailyDate(epoch);
    if (!live(epoch)) return;
    syncClaudeCredential();
    syncGrokCredential();
    const details = formatDetails(codex, antigravity, sessionTotals, dailyTotals, config.refreshIntervalSeconds, claude, grok);
    if (ctx.hasUI) ctx.ui.notify(details, "info");
    else console.log(details);
  };

  const handleAccountCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const raw = args.trim();
    let action = raw.split(/\s+/)[0], rest = raw.slice(action.length).trim();
    if (action === "reset") { const kind = rest.split(/\s+/)[0]; action = `reset-${kind}`; rest = rest.slice(kind.length).trim(); }
    const globalAction = ["backup", "backups", "restore"].includes(action);
    let provider: AccountProvider = isAccountProvider(ctx.model?.provider) ? ctx.model.provider : "openai-codex";
    const prefix = rest.split(/\s+/)[0];
    if (!globalAction && isAccountProvider(prefix)) { provider = prefix; rest = rest.slice(prefix.length).trim(); }
    let label = globalAction ? rest : rest.split(/\s+/)[0];
    const extra = globalAction ? "" : rest.slice(label.length).trim();
    const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
      accountNotice = { message: text, level, at: Math.max(Date.now(), (accountNotice?.at ?? 0) + 1) };
      const activeCtx = currentContext ?? ctx;
      if (activeCtx.hasUI) activeCtx.ui.notify(text, level); else console.error(text);
    };
    const targetIdentity = async () => {
      if (label === "current") {
        const a = await resolveCredentialAccount(provider, credential(readStoredCredential(provider), provider));
        return a;
      }
      if (label.startsWith("account:")) {
        const a = accountIdentities().find((a) => `account:${a.key}` === label);
        if (a) return a;
      } else {
        const p = (await listAccounts(provider)).profiles.find((p) => p.name === label);
        if (p) return rememberAccount(provider, p.accountId);
      }
      throw new Error("Unknown account profile.");
    };
    try {
      if (!action || action === "list" || action === "current") {
        const listed = await listAllAccounts();
        notify(ACCOUNT_PROVIDERS.map((p) => {
          const a = listed.accounts.find((a) => a.provider === p && a.accountId === activeAccountId(p));
          const identities = listed.accounts.filter((a) => a.provider === p).map((a) => {
            const profiles = listed.profiles.filter((profile) => profile.key === a.key).map((profile) => profile.name);
            return `  ${accountDisplayName(a)}${a.organization ? ` · ${a.organization}` : ""} [${accountViewId(p, a.accountId)}]${profiles.length ? ` · profiles: ${profiles.join(", ")}` : " · 无保存凭据"}`;
          });
          return `${PROVIDER_NAMES[p]} 当前：${a ? accountDisplayName(a) : "未登录 / 身份未确认"}${listed.current[p] ? ` [${listed.current[p]}]` : ""}\n${identities.join("\n") || "  无已识别账号"}`;
        }).join("\n"));
      } else if (action === "save" && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        if (!label) {
          const a = await resolveCredentialAccount(provider, credential(readStoredCredential(provider), provider));
          label = `account-${a.key.slice(0, 8)}`;
        }
        await backupHistory(); await saveAccount(label, provider);
        if (active) void refresh(provider, ctx, true);
        notify(`已保存当前 ${PROVIDER_NAMES[provider]} OAuth 账号：${label}`);
      } else if (action === "import" && label && extra) {
        await ctx.waitForIdle(); await backupHistory(); await importAccount(label, extra, provider);
        notify(`已导入账号：${label}（${PROVIDER_NAMES[provider]}，未切换）`);
      } else if (action === "note" && label) {
        const a = await targetIdentity(); await setAccountNote(a.provider, a.accountId, extra);
        notify(extra ? `已更新账号备注：${extra}` : "已清除备注，将显示邮箱或账号短 ID。");
      } else if (action === "delete" && label && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        if (!ctx.hasUI) throw new Error("Delete requires an interactive confirmation.");
        if (!await ctx.ui.confirm("删除账号 profile", `备份后删除 ${PROVIDER_NAMES[provider]} / ${label} 的保存凭据？不会删除历史账号或账本。`)) return;
        await backupHistory(); await deleteAccount(label, provider);
        notify(`已删除 profile：${label}（历史账号和用量仍保留）`);
      } else if (action === "use" && label && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        if (ctx.hasPendingMessages()) throw new Error("Please clear queued messages before switching.");
        if (ctx.hasUI && !await ctx.ui.confirm(`切换 ${PROVIDER_NAMES[provider]} 账号`, `切换到 ${label}？只替换 ${PROVIDER_NAMES[provider]} 凭据，不会强制切换当前会话，也不会切换模型。共享 auth.json 的其他 Pi 进程也受影响，请确认它们没有进行中的请求。`)) return;
        const target = (await listAccounts(provider)).profiles.find((p) => p.name === label);
        if (!target) throw new Error("Unknown account profile.");
        await backupHistory();
        const rollback = await useAccount(label, provider);
        let verifiedAccess: string | undefined;
        try {
          const resolved = await ctx.modelRegistry.getProviderAuth(provider);
          if (!resolved || !oauthAccessMatches(resolved.auth, provider)) throw new Error("Selected credential was not loaded.");
          verifiedAccess = resolvedAccess(resolved.auth);
          const identity = await resolveCredentialAccount(provider, credential(readStoredCredential(provider), provider));
          if (identity.accountId !== target.accountId) throw new Error("Selected credential identity differs.");
          await saveAccount(label, provider); // Persist any refresh performed by Pi during verification.
        } catch {
          await rollback(verifiedAccess);
          throw new Error("Pi did not load the selected OAuth credential; account switch rolled back.");
        }
        if (active && currentContext) void refresh(provider, currentContext, true);
        notify(`已切换 ${PROVIDER_NAMES[provider]} 账号为：${label}。当前会话和模型保留；账本筛选不变。`);
      } else if (action === "backup" && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        notify(`备份已创建：${await backupHistory(label || undefined)}（含 OAuth 凭据，请妥善保管）`);
      } else if (action === "backups" && !label) {
        notify((await listBackups()).join("\n") || "暂无备份");
      } else if (action === "restore" && label && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        const contents = await inspectHistory(label);
        if (!ctx.hasUI) throw new Error("Restore requires an interactive confirmation.");
        if (!await ctx.ui.confirm("导入历史", `账号：${contents.profiles.join(", ") || "无"}；用量记录：${contents.records} 条。合并并先备份当前数据？同名账号不会覆盖。`)) return;
        await backupHistory(); const restored = await importHistory(label);
        dailyDate = ""; await updateDailyDate(generation); await Promise.all(accountAggregators.map((view) => view.refresh()));
        notify(`已导入 ${restored.profiles} 个账号、${restored.records} 条记录。`);
      } else if (action === "reset-cache" && !label) {
        const cache = provider === "openai-codex" ? codex : provider === "anthropic" ? claude : grok;
        cache.lastAttemptAt = undefined;
        if (active) await refresh(provider, ctx, true);
        notify(`当前 ${PROVIDER_NAMES[provider]} 额度缓存已清除并重新查询。`);
      } else if (action === "reset-usage" && label && !extra) {
        await ctx.waitForIdle(); await ledgerQueue;
        const a = await targetIdentity();
        if (!ctx.hasUI) throw new Error("Reset requires an interactive confirmation.");
        if (!await ctx.ui.confirm("清除本地用量", `清除 ${PROVIDER_NAMES[a.provider]} / ${accountDisplayName(a)} 的本地用量？将先备份，不能重置服务商实际额度。`)) return;
        const result = await resetAccountUsage(a.accountId, a.provider);
        dailyDate = ""; await updateDailyDate(generation); await Promise.all(accountAggregators.map((view) => view.refresh()));
        notify(`已清除 ${result.removed} 条记录；备份：${result.backup}（不含 OAuth 凭据）`);
      } else notify("使用 /quota-account-save [provider] [名称]、/quota-account-use [provider] <名称>、/quota-account-note <账号> [备注] 等命令。", "warning");
    } catch (error) { notify(safeAccountFailure(error), "error"); }
  };
  const accountCommands = [
    ["quota-account-list", "list", "List Codex / Claude / Grok accounts and profiles"],
    ["quota-account-current", "current", "Show each provider's current OAuth account"],
    ["quota-account-save", "save", "Save current native Pi OAuth profile"],
    ["quota-account-import", "import", "Import a native Pi OAuth profile"],
    ["quota-account-use", "use", "Switch a provider's OAuth account without changing model or session"],
    ["quota-account-note", "note", "Set or clear an account note (provider/profile or account view ID)"],
    ["quota-account-delete", "delete", "Delete an inactive OAuth profile, retaining its history"],
    ["quota-account-backup", "backup", "Back up profiles and usage (optional private directory)"],
    ["quota-account-backups", "backups", "List account backups"],
    ["quota-account-restore", "restore", "Restore account backup"],
    ["quota-account-reset-cache", "reset cache", "Refresh a provider's current OAuth quota cache"],
    ["quota-account-reset-usage", "reset usage", "Reset local usage for an account"],
  ] as const;
  for (const [name, action, description] of accountCommands) {
    pi.registerCommand(name, { description, handler: (args, ctx) => handleAccountCommand(`${action}${args.trim() ? ` ${args.trim()}` : ""}`, ctx) });
  }

  pi.registerCommand("quota", {
    description: "Show quota and token details",
    handler: handleQuotaCommand,
  });
  pi.registerCommand("quota-console", {
    description: "Open the local quota console",
    handler: (_args, ctx) => handleQuotaCommand("console", ctx),
  });
  pi.registerCommand("quota-refresh", {
    description: "Refresh provider quotas",
    handler: (_args, ctx) => handleQuotaCommand("refresh", ctx),
  });
  pi.registerCommand("quota-interval", {
    description: "Set quota refresh interval (60–3600 seconds)",
    handler: (args, ctx) => handleQuotaCommand(`interval ${args}`, ctx),
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeChildEvents.forEach((unsubscribe) => unsubscribe?.());
    childUsage?.dispose();
    childUsage = undefined;
    active = false;
    generation++;
    abortController?.abort();
    abortController = undefined;
    scheduler?.stop();
    scheduler = undefined;
    dashboard = undefined;
    accountAggregators.forEach((view) => view.stop());
    accountAggregators = [];
    views.clear();
    delete inFlight["openai-codex"];
    delete inFlight.antigravity;
    delete inFlight.anthropic;
    delete inFlight.xai;
    requestAccounts.clear();
    currentContext = undefined;
    try { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined); }
    catch { /* A closing UI must not prevent ledger flushing. */ }
    // Pi awaits shutdown handlers; flush the last assistant's ledger write before exit or session replacement.
    await Promise.allSettled([ledgerQueue, readingsQueue,
      detachDashboard(dashboardOwner, !_event.reason || _event.reason === "quit")]);
  });
}
