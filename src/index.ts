import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { QuotaDashboard } from "./dashboard.js";
import { queryAntigravityQuota, queryNativeAntigravityQuota } from "./providers/antigravity.js";
import { queryCodexQuota } from "./providers/codex.js";
import { RefreshScheduler } from "./scheduler.js";
import { formatDetails, formatStatus } from "./statusline.js";
import { UsageAggregator } from "./tokens/aggregate.js";
import { accumulate, emptyTotals, tokenRecord } from "./tokens/collector.js";
import { antigravityWindowDuration, estimateQuotaAmount, FIVE_HOURS_MS, ONE_WEEK_MS } from "./quota-estimate.js";
import { appendUsage, localDate, readDailyUsage } from "./tokens/store.js";
import type { AntigravityQuota, CodexQuota, MonitorConfig, ProviderCache, QuotaAmountEstimates, TokenTotals } from "./types.js";

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

function contextMetrics(ctx: ExtensionContext): { tokens: number | null; contextWindow: number; percent: number | null } | null {
  const usage = ctx.getContextUsage();
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

function quotaAmountEstimates(
  aggregator: UsageAggregator,
  codex: ProviderCache<CodexQuota>,
  antigravity: ProviderCache<AntigravityQuota>,
): QuotaAmountEstimates {
  const now = Date.now();
  const ledgerStale = aggregator.state().stale;
  const estimate = (provider: string, window: Parameters<typeof estimateQuotaAmount>[0], durationMs: number | undefined) =>
    estimateQuotaAmount(window, durationMs,
      (startAt, endAt) => aggregator.estimateCostForPeriod(provider, startAt, endAt), now, ledgerStale);
  return {
    codex: {
      fiveHour: estimate("openai-codex", codex.value?.fiveHour,
        (codex.value?.fiveHour?.windowMinutes ?? FIVE_HOURS_MS / 60_000) * 60_000),
      weekly: estimate("openai-codex", codex.value?.weekly,
        (codex.value?.weekly?.windowMinutes ?? ONE_WEEK_MS / 60_000) * 60_000),
    },
    antigravity: { groups: (antigravity.value?.groups ?? []).map((group) => ({
      name: group.name,
      windows: group.windows.map((window) => {
        const durationMs = antigravityWindowDuration(window.label);
        return durationMs === undefined ? null : estimate("antigravity", window, durationMs);
      }),
    })) },
  };
}

export default function quotaMonitor(pi: ExtensionAPI): void {
  let active = false;
  let generation = 0;
  let config: MonitorConfig = { ...DEFAULT_CONFIG };
  let scheduler: RefreshScheduler | undefined;
  let dashboard: QuotaDashboard | undefined;
  let usageAggregator: UsageAggregator | undefined;
  let abortController: AbortController | undefined;
  let currentContext: ExtensionContext | undefined;
  let sessionTotals = emptyTotals();
  let dailyTotals = emptyTotals();
  let dailyDate = "";
  let ledgerQueue: Promise<void> = Promise.resolve();
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

  function refresh(provider: ProviderId, ctx: ExtensionContext, force = false): Promise<void> {
    if (!active) return Promise.resolve();
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
          const configured = ctx.modelRegistry.getProvider(provider);
          const baseUrl = configured?.baseUrl ?? configured?.getModels()[0]?.baseUrl;
          if (!baseUrl || new URL(baseUrl).origin !== "https://chatgpt.com") {
            throw new Error("Codex credential belongs to a custom endpoint.");
          }
          const resolved = await ctx.modelRegistry.getProviderAuth(provider);
          if (!live(epoch)) return;
          if (!resolved) throw new Error("Codex credentials unavailable");
          const result = await queryCodexQuota(resolved.auth, signal, timeoutMs);
          if (!live(epoch)) return;
          codex.value = result;
          codex.error = undefined;
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
        }
      } catch (error) {
        if (!live(epoch)) return;
        cache.error = safeFailure(error);
      } finally {
        if (live(epoch)) render(ctx);
      }
    })();
    inFlight[provider] = promise;
    void promise.finally(() => { if (inFlight[provider] === promise) delete inFlight[provider]; }).catch(() => {});
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
      const totals = await readDailyUsage(date);
      if (live(epoch)) { dailyDate = date; dailyTotals = totals; }
    } catch { /* Keep the last valid daily result. */ }
  }

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++generation;
    active = true;
    abortController = new AbortController();
    currentContext = ctx;
    config = await loadConfig();
    if (!live(epoch)) return;
    delete inFlight["openai-codex"];
    delete inFlight.antigravity;
    codex.value = undefined;
    codex.error = undefined;
    codex.lastAttemptAt = undefined;
    antigravity.value = undefined;
    antigravity.error = undefined;
    antigravity.lastAttemptAt = undefined;
    sessionTotals = branchTotals(ctx);
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
    // Do not block startup on remote providers.
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

  pi.on("message_end", (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    const record = tokenRecord(event.message);
    if (record) {
      sessionTotals = accumulate(sessionTotals, record);
      ledgerQueue = ledgerQueue.then(async () => {
        await appendUsage(record);
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
      if (event.message.provider === "openai-codex" || event.message.provider === "antigravity") {
        void refresh(event.message.provider, ctx, true);
      }
    } else if (event.message.provider === "openai-codex" || event.message.provider === "antigravity") {
      void refresh(event.message.provider, ctx);
    }
  });

  const handleQuotaCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (!active) return;
    const epoch = generation;
    const command = args.trim();
    if (command === "console") {
      if (!dashboard) {
        const aggregator = new UsageAggregator();
        await aggregator.start();
        if (!live(epoch)) { aggregator.stop(); return; }
        usageAggregator = aggregator;
        dashboard = new QuotaDashboard({
          state: () => {
            const usage = aggregator.state();
            return { codex, antigravity, usage, context: currentContext ? contextMetrics(currentContext) : null,
              quotaEstimates: quotaAmountEstimates(aggregator, codex, antigravity), config, updatedAt: Date.now() };
          },
          refresh: async () => {
            if (!live(epoch) || !currentContext) throw new Error("Session is no longer active.");
            await refreshAll(currentContext, true);
            await updateDailyDate(epoch);
          },
          setInterval: (seconds) => setIntervalSeconds(seconds, epoch),
          setStatusbar: (settings) => setStatusbarSettings(settings, epoch),
        });
      }
      try {
        const url = await dashboard.start();
        if (!live(epoch)) return;
        render(ctx); // Keep this extension's RPC statusbar entry visible according to its settings.
        const message = `额度控制台：${url}（仅本机访问；本会话结束后关闭）`;
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else console.log(message);
      } catch {
        if (!live(epoch)) return;
        dashboard = undefined;
        usageAggregator?.stop();
        usageAggregator = undefined;
        render(ctx);
        ctx.ui.notify("无法启动本地额度控制台。", "error");
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
    active = false;
    generation++;
    abortController?.abort();
    abortController = undefined;
    scheduler?.stop();
    scheduler = undefined;
    const closingDashboard = dashboard;
    dashboard = undefined;
    usageAggregator?.stop();
    usageAggregator = undefined;
    delete inFlight["openai-codex"];
    delete inFlight.antigravity;
    currentContext = undefined;
    try { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined); }
    catch { /* A closing UI must not prevent ledger flushing. */ }
    // Pi awaits shutdown handlers; flush the last assistant's ledger write before exit or session replacement.
    await Promise.allSettled([ledgerQueue, closingDashboard?.stop()]);
  });
}
