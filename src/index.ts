import { readStoredCredential, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeAccountId, deleteAccount, importAccount, listAccounts, saveAccount, useAccount } from "./accounts.js";
import { backupHistory, importHistory, inspectHistory, listBackups, resetAccountUsage } from "./history.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import type { QuotaDashboard } from "./dashboard.js";
import { attachDashboard, detachDashboard } from "./resident-dashboard.js";
import { QuotaReadings } from "./quota-readings.js";
import { CodexPeriodStore } from "./codex-periods.js";
import { queryAntigravityQuota, queryNativeAntigravityQuota } from "./providers/antigravity.js";
import { queryCodexQuota } from "./providers/codex.js";
import { RefreshScheduler } from "./scheduler.js";
import { formatDetails, formatStatus } from "./statusline.js";
import { UsageAggregator } from "./tokens/aggregate.js";
import { accumulate, emptyTotals, tokenRecord } from "./tokens/collector.js";
import { quotaAmountEstimates } from "./quota-estimate.js";
import { appendUsage, localDate, readDailyUsage } from "./tokens/store.js";
import { subagentUsage } from "./tokens/subagents.js";
import type { AntigravityQuota, CodexQuota, MonitorConfig, ProviderCache, TokenTotals } from "./types.js";

const STATUS_KEY = "pi-quota-monitor";
type ProviderId = "openai-codex" | "antigravity";

function safeFailure(error: unknown): string {
  // Never display provider response bodies, authorization headers, or error messages containing secrets.
  if (error instanceof Error && error.message === "Codex credential belongs to a custom endpoint.") return error.message;
  if (error instanceof Error && /credentials unavailable|credential unavailable|Invalid Antigravity provider credential/i.test(error.message)) return "Not logged in";
  if (error instanceof Error && error.message === "agy binary unavailable.") return "agy executable unavailable";
  if (error instanceof Error && error.message === "agy usage timed out.") return "agy native query timed out";
  return "Query failed; retry later";
}

function safeAccountFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    "Only Pi's native Codex OAuth profiles with accountId are supported.",
    "Invalid profile name (use letters, digits, dots, underscores or hyphens).",
    "Profile name belongs to another account.",
    "Current profile differs from Pi login; save it before switching.",
    "Save the current Pi account before switching.",
    "Invalid Pi auth.json.",
    "Profile already exists; import will not overwrite it.",
    "Invalid backup.", "Unsupported backup format.", "Invalid backup profile.", "Invalid backup ledger.",
    "Profile name conflict; import aborted.", "An account ID is required.",
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
  const reconcileChildren = () => { void childUsage?.reconcile(); }; // No reliable account binding for detached children.
  let requestAccountId: string | undefined;
  let codexAccountId: string | undefined;
  const codex: ProviderCache<CodexQuota> = {};
  const antigravity: ProviderCache<AntigravityQuota> = {};
  const inFlight: Partial<Record<ProviderId, Promise<void>>> = {};

  function live(epoch: number): boolean {
    return active && generation === epoch && !abortController?.signal.aborted;
  }

  function render(ctx: ExtensionContext): void {
    if (!active || !ctx.hasUI) return;
    // RPC setStatus is forwarded by pi-web; TUI uses its native status footer.
    try {
      const visibility = ctx.mode === "rpc"
        ? { showOai: config.showOaiInStatusbar, showAgy: config.showAgyInStatusbar }
        : undefined; // TUI statusbars retain the historical OAI + AGY display.
      ctx.ui.setStatus(STATUS_KEY, formatStatus(codex, antigravity, sessionTotals, config.showReset, Date.now(), visibility));
    } catch {
      // A closing/replaced UI must not turn a completed quota query into an unhandled rejection.
    }
  }

  async function restoreCodex(account: string | undefined, epoch: number): Promise<void> {
    const readings = account ? await new QuotaReadings("codex", account).load() : [];
    if (!live(epoch) || codexAccountId !== account || activeAccountId() !== account) return;
    codexHistory = readings;
    if (!codex.value && readings.length) { codex.value = readings.at(-1); codex.restored = true; }
  }

  async function syncCodexPeriods(account: string, view?: UsageAggregator): Promise<void> {
    if (codexAccountId !== account || activeAccountId() !== account || !codex.value) return;
    const usage = view ?? new UsageAggregator(undefined, account);
    await ledgerQueue;
    await usage.refresh();
    if (codexAccountId !== account || activeAccountId() !== account) return;
    const estimates = quotaAmountEstimates(usage, codex, {}, codexHistory, []).codex;
    await new CodexPeriodStore(account).update(codexHistory, estimates);
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
    const cache = provider === "openai-codex" ? codex : antigravity;
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
          if (!resolved) throw new Error("Codex credentials unavailable");
          const result = await queryCodexQuota(resolved.auth, signal, timeoutMs);
          if (!live(epoch) || activeAccountId() !== account) return;
          codex.value = result;
          codex.error = undefined;
          codex.restored = false;
          codexHistory = [...codexHistory.filter((q) => q.capturedAt > Date.now() - 8 * 86_400_000), result];
          if (account) {
            await persistReading(() => new QuotaReadings("codex", account).append(result), codex, epoch);
            try { await syncCodexPeriods(account, views.get(`account:${account}`)); }
            catch { if (live(epoch) && codexAccountId === account) codex.storageError = "周期估算记录保存失败；当前额度读数仍可用。"; }
          }
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
        if (!live(epoch) || (provider === "openai-codex" && activeAccountId() !== account)) return;
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
      if (provider === "openai-codex" && live(epoch) && activeAccountId() !== account && currentContext) {
        void refresh(provider, currentContext, true);
      }
    }).catch(() => {});
    return promise;
  }

  async function refreshAll(ctx: ExtensionContext, force = false): Promise<void> {
    await Promise.all([refresh("openai-codex", ctx, force), refresh("antigravity", ctx, force)]);
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

  async function setStatusbarSettings(settings: Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showAgyInStatusbar">>, epoch: number): Promise<void> {
    if (!live(epoch)) throw new Error("Session is no longer active.");
    const next = { ...config, ...settings };
    await saveConfig(next);
    if (!live(epoch)) throw new Error("Session is no longer active.");
    config = next;
    if (currentContext) render(currentContext);
  }

  async function updateDailyDate(epoch: number): Promise<void> {
    await ledgerQueue;
    if (!live(epoch)) return;
    const date = localDate(Date.now());
    if (date === dailyDate) return;
    try {
      const totals = await readDailyUsage(date, activeAccountId() ?? null);
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
            if (localDate(record.timestamp) === dailyDate && (record.provider !== "openai-codex" || record.accountId === activeAccountId()))
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
    codexAccountId = activeAccountId();
    requestAccountId = undefined;
    codex.value = undefined;
    codex.error = undefined;
    codex.lastAttemptAt = undefined;
    antigravity.value = undefined;
    antigravity.error = undefined;
    antigravity.lastAttemptAt = undefined;
    codex.restored = antigravity.restored = false;
    codex.storageError = antigravity.storageError = undefined;
    await readingsQueue;
    codexRestore = restoreCodex(codexAccountId, epoch);
    const restoredAgy = await agyReadings.load();
    await codexRestore;
    if (!live(epoch)) return;
    agyHistory = restoredAgy;
    antigravity.value = agyHistory.at(-1);
    antigravity.restored = !!antigravity.value;
    await ledgerQueue;
    if (!live(epoch)) return;
    dailyDate = localDate(Date.now());
    try { dailyTotals = await readDailyUsage(dailyDate, activeAccountId() ?? null); }
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
    if (_event.model.provider === "openai-codex" || _event.model.provider === "antigravity") {
      void refresh(_event.model.provider, ctx, true);
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (event.status !== 429 || !active) return;
    const provider = ctx.model?.provider;
    if (provider === "openai-codex" || provider === "antigravity") void refresh(provider, ctx, true);
  });

  pi.on("before_provider_headers", (_event, ctx) => {
    if (active && ctx.model?.provider === "openai-codex") requestAccountId = activeAccountId();
  });

  pi.on("message_end", (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    const record = tokenRecord(event.message);
    if (record) {
      record.source = "pi-message";
      record.sessionId = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.();
    }
    if (record?.provider === "openai-codex" && requestAccountId) record.accountId = requestAccountId;
    requestAccountId = undefined;
    if (record) {
      sessionTotals = accumulate(sessionTotals, record);
      ledgerQueue = ledgerQueue.then(async () => {
        const appended = await appendUsage(record);
        if (!appended) return;
        const date = localDate(Date.now());
        if (date !== dailyDate) {
          dailyDate = date;
          dailyTotals = await readDailyUsage(date, activeAccountId() ?? null);
        } else {
          if (record.provider !== "openai-codex" || record.accountId === (activeAccountId() ?? null)) {
            dailyTotals = accumulate(dailyTotals, record);
          }
        }
      }).catch(() => {
        // Failed writes must not corrupt the on-screen session count.
      });
      render(ctx);
    }
    if (event.message.stopReason === "error" && /429|quota|rate.limit|RESOURCE_EXHAUSTED/i.test(event.message.errorMessage ?? "")) {
      if (event.message.provider === "openai-codex" || event.message.provider === "antigravity") {
        void refresh(event.message.provider, ctx, true);
      }
    } else if (event.message.provider === "openai-codex" || event.message.provider === "antigravity") {
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
    if (command === "console") {
      try {
      if (!dashboard) {
        let syncingViews: Promise<{ accounts: Array<{ id: string; name: string }>; currentId?: string; currentProfile?: string; profiles: Array<{ name: string; accountId: string }> }> | undefined;
        const ensureViews = () => {
          if (syncingViews) return syncingViews;
          syncingViews = (async () => {
            if (!live(epoch)) throw new Error("Session is no longer active.");
            const listed = await listAccounts();
            const currentId = activeAccountId();
            const accounts = [{ id: "all", name: "总体用量" }];
            for (const item of listed.profiles) {
              const id = `account:${item.accountId}`;
              if (!accounts.some((account) => account.id === id)) accounts.push({ id, name: item.name });
            }
            if (currentId && !accounts.some((item) => item.id === `account:${currentId}`)) accounts.push({ id: `account:${currentId}`, name: "当前账号" });
            for (const [id, view] of views) {
              if (accounts.some((item) => item.id === id)) continue;
              view.stop();
              views.delete(id);
              accountAggregators = accountAggregators.filter((item) => item !== view);
            }
            for (const item of accounts) {
              if (views.has(item.id)) continue;
              const view = new UsageAggregator(undefined, item.id === "all" ? undefined : item.id.slice("account:".length));
              await view.start();
              if (!live(epoch)) { view.stop(); throw new Error("Session is no longer active."); }
              views.set(item.id, view);
              accountAggregators.push(view);
            }
            if (!live(epoch)) throw new Error("Session is no longer active.");
            return { accounts, currentId, currentProfile: listed.current, profiles: listed.profiles };
          })().finally(() => { syncingViews = undefined; });
          return syncingViews;
        };
        try { await ensureViews(); }
        catch { accountAggregators.forEach((view) => view.stop()); accountAggregators = []; views.clear(); throw new Error("Unable to load account usage."); }
        dashboard = await attachDashboard(dashboardOwner, {
          state: async (requested) => {
            const { accounts, currentId, currentProfile, profiles } = await ensureViews();
            const defaultId = currentId ? `account:${currentId}` : "all";
            const selected = requested && views.has(requested) ? requested : defaultId;
            const view = views.get(selected)!;
            // A saved historical account (or the overall ledger) has no live Codex
            // quota. Show/estimate it only when the viewed accountId is active.
            const showingCurrent = currentId !== undefined && selected === `account:${currentId}`;
            const visibleCodex = showingCurrent && codexAccountId === currentId ? codex : {};
            await ledgerQueue;
            if ((view.state().updatedAt ?? 0) < Math.max(visibleCodex.value?.capturedAt ?? 0, antigravity.value?.capturedAt ?? 0)) await view.refresh();
            const quotaEstimates = quotaAmountEstimates(view, visibleCodex, antigravity, codexHistory, agyHistory);
            let codexPeriods = [] as Awaited<ReturnType<CodexPeriodStore["load"]>>;
            try {
              codexPeriods = selected === "all" ? [] : showingCurrent && currentId && codexAccountId === currentId
                ? await new CodexPeriodStore(currentId).update(codexHistory, quotaEstimates.codex)
                : await new CodexPeriodStore(selected.slice("account:".length)).load();
            } catch {
              if (showingCurrent) codex.storageError = "周期估算记录读取失败；当前额度读数仍可用。";
            }
            const backups = await listBackups();
            if (!live(epoch)) throw new Error("Session is no longer active.");
            return { accounts, currentProfile, profiles, backups, accountNotice, selectedAccountId: selected,
              codexPeriods,
              currentAccountId: currentId ? `account:${currentId}` : undefined, codex: visibleCodex,
              antigravity, usage: { ...view.state(), childUsageIncomplete }, context: currentContext ? contextMetrics(currentContext) : null,
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
          refresh: async () => {
            if (!live(epoch) || !currentContext) throw new Error("Session is no longer active.");
            await refreshAll(currentContext, true);
            await updateDailyDate(epoch);
          },
          setInterval: (seconds) => setIntervalSeconds(seconds, epoch),
          setPort: (port) => setDashboardPort(port, epoch),
          setStatusbar: (settings) => setStatusbarSettings(settings, epoch),
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
    const details = formatDetails(codex, antigravity, sessionTotals, dailyTotals, config.refreshIntervalSeconds);
    if (ctx.hasUI) ctx.ui.notify(details, "info");
    else console.log(details);
  };

  const handleAccountCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const raw = args.trim();
      const [action, first, second, surplus] = raw.split(/\s+/);
      const pathAction = action === "restore" || action === "backup";
      const label = pathAction ? raw.slice(action.length).trim() : first;
      const extra = pathAction ? undefined : action === "import" && first ? raw.slice(action.length).trimStart().slice(first.length).trimStart() : second;
      if (surplus && action !== "import" && !pathAction) { ctx.ui.notify("参数过多。", "warning"); return; }
      const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
        accountNotice = { message: text, level, at: Math.max(Date.now(), (accountNotice?.at ?? 0) + 1) };
        const activeCtx = currentContext ?? ctx;
        if (activeCtx.hasUI) activeCtx.ui.notify(text, level);
        else console.error(text);
      };
      try {
        if (!action || action === "list" || action === "current") {
          const { current, profiles } = await listAccounts();
          notify(`当前：${current ?? `未保存 (${activeAccountId() ?? "未知"})`}\n${profiles.map((p) => `${p.name === current ? "* " : "  "}${p.name} (${p.accountId})`).join("\n") || "无已保存账号"}`);
        } else if (action === "save" && label && !extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          await backupHistory();
          await saveAccount(label);
          if (active) void refresh("openai-codex", ctx, true);
          notify(`已保存当前 Pi OAuth 账号：${label}`);
        } else if (action === "import" && label && extra) {
          await ctx.waitForIdle();
          await backupHistory();
          await importAccount(label, extra);
          notify(`已导入账号：${label}（未切换）`);
        } else if (action === "delete" && label && !extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          if (!ctx.hasUI) throw new Error("Delete requires an interactive confirmation.");
          if (!await ctx.ui.confirm("删除账号 profile", `备份后删除 ${label} 的保存凭据？不会删除账本，也不会退出 Pi 当前登录。`)) return;
          await backupHistory();
          await deleteAccount(label);
          notify(`已删除 profile：${label}（历史用量仍保留）`);
        } else if (action === "use" && label && !extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          if (ctx.hasPendingMessages()) throw new Error("Please clear queued messages before switching.");
          if (ctx.hasUI && !await ctx.ui.confirm("切换 Codex 账号", `切换到 ${label}？将替换 Pi 的 Codex 凭据，不会强制切换当前会话。`)) return;
          const old = (await listAccounts()).current;
          await backupHistory();
          await useAccount(label);
          try {
            // As in pi-auth use, switch only the Codex entry in auth.json. Pi's
            // credential store reloads its revision on the next request. A session
            // replacement is independent and may be vetoed by other extensions.
            const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
            const stored = readStoredCredential("openai-codex");
            if (activeAccountId() !== (await listAccounts()).profiles.find((p) => p.name === label)?.accountId
              || !stored || stored.type !== "oauth" || !resolved || resolved.auth.apiKey !== stored.access) {
              throw new Error("Pi did not load the selected Codex credential; account switch rolled back.");
            }
          } catch (error) {
            if (old && old !== label) await useAccount(old);
            throw error;
          }
          if (active && currentContext) {
            void refresh("openai-codex", currentContext, true);
            void updateDailyDate(generation);
          }
          notify(`已切换 Codex 账号为：${label}。当前会话保留；如需全新 Pi 进程，请退出并重新启动 Pi。`);
        } else if (action === "backup" && !extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          notify(`备份已创建：${await backupHistory(label || undefined)}（含 OAuth 凭据，请妥善保管）`);
        } else if (action === "backups" && !label) {
          notify((await listBackups()).join("\n") || "暂无备份");
        } else if (action === "restore" && label && !extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          const contents = await inspectHistory(label);
          if (!ctx.hasUI) throw new Error("Restore requires an interactive confirmation.");
          if (!await ctx.ui.confirm("导入历史", `账号：${contents.profiles.join(", ") || "无"}；用量记录：${contents.records} 条。合并并先备份当前数据？同名账号不会覆盖。`)) return;
          await backupHistory();
          const restored = await importHistory(label);
          dailyDate = "";
          await updateDailyDate(generation);
          await Promise.all(accountAggregators.map((view) => view.refresh()));
          notify(`已导入 ${restored.profiles} 个账号、${restored.records} 条记录。`);
        } else if (action === "reset" && label === "cache" && !extra) {
          codex.lastAttemptAt = undefined;
          if (active) await refresh("openai-codex", ctx, true);
          notify("当前 Codex 额度缓存已清除并重新查询。");
        } else if (action === "reset" && label === "usage" && extra) {
          await ctx.waitForIdle();
          await ledgerQueue;
          const profile = (await listAccounts()).profiles.find((item) => item.name === extra);
          if (!profile) throw new Error("Unknown account profile.");
          if (!ctx.hasUI) throw new Error("Reset requires an interactive confirmation.");
          if (!await ctx.ui.confirm("清除本地用量", `清除 ${extra} 的本地 Codex 用量？将先备份，不能重置 OpenAI 实际额度。`)) return;
          const result = await resetAccountUsage(profile.accountId);
          dailyDate = "";
          await updateDailyDate(generation);
          await Promise.all(accountAggregators.map((view) => view.refresh()));
          notify(`已清除 ${result.removed} 条记录；备份：${result.backup}`);
        } else notify("使用 /quota-account-list、/quota-account-save、/quota-account-use 等连字符命令。", "warning");
      } catch (error) {
        notify(safeAccountFailure(error), "error");
      }
  };
  const accountCommands = [
    ["quota-account-list", "list", "List Codex profiles"],
    ["quota-account-current", "current", "Show current Codex profile"],
    ["quota-account-save", "save", "Save current native Pi OAuth profile"],
    ["quota-account-import", "import", "Import a native Pi OAuth profile"],
    ["quota-account-use", "use", "Switch Codex credential without replacing the session"],
    ["quota-account-delete", "delete", "Delete an inactive saved Codex profile"],
    ["quota-account-backup", "backup", "Back up profiles and usage (optional private directory)"],
    ["quota-account-backups", "backups", "List account backups"],
    ["quota-account-restore", "restore", "Restore account backup"],
    ["quota-account-reset-cache", "reset cache", "Refresh current Codex quota cache"],
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
    description: "Refresh Codex and Antigravity quotas",
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
    currentContext = undefined;
    try { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined); }
    catch { /* A closing UI must not prevent ledger flushing. */ }
    // Pi awaits shutdown handlers; flush the last assistant's ledger write before exit or session replacement.
    await Promise.allSettled([ledgerQueue, readingsQueue,
      detachDashboard(dashboardOwner, !_event.reason || _event.reason === "quit")]);
  });
}
