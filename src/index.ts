import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { QuotaDashboard } from "./dashboard.js";
import { queryAntigravityQuota, queryNativeAntigravityQuota } from "./providers/antigravity.js";
import { queryCodexQuota } from "./providers/codex.js";
import { RefreshScheduler } from "./scheduler.js";
import { formatDetails, formatStatus } from "./statusline.js";
import { accumulate, emptyTotals, tokenRecord } from "./tokens/collector.js";
import { appendUsage, localDate, readDailyUsage } from "./tokens/store.js";
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

function branchTotals(ctx: ExtensionContext): TokenTotals {
  return ctx.sessionManager.getBranch().reduce((totals, entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return totals;
    const record = tokenRecord(entry.message);
    return record ? accumulate(totals, record) : totals;
  }, emptyTotals());
}

export default function quotaMonitor(pi: ExtensionAPI): void {
  let active = false;
  let generation = 0;
  let config: MonitorConfig = { ...DEFAULT_CONFIG };
  let scheduler: RefreshScheduler | undefined;
  let dashboard: QuotaDashboard | undefined;
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
      ctx.ui.setStatus(STATUS_KEY, dashboard && ctx.mode === "rpc"
        ? undefined
        : formatStatus(codex, antigravity, sessionTotals, config.showReset));
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

  pi.registerCommand("quota", {
    description: "Quota details; /quota console; /quota refresh; /quota interval <60-3600 seconds>",
    handler: async (args, ctx) => {
      if (!active) return;
      const epoch = generation;
      const command = args.trim();
      if (command === "console") {
        if (!dashboard) {
          dashboard = new QuotaDashboard({
            state: () => ({ codex, antigravity, session: sessionTotals, daily: dailyTotals, config, updatedAt: Date.now() }),
            refresh: async () => {
              if (!live(epoch) || !currentContext) throw new Error("Session is no longer active.");
              await refreshAll(currentContext, true);
              await updateDailyDate(epoch);
            },
            setInterval: (seconds) => setIntervalSeconds(seconds, epoch),
          });
        }
        try {
          const url = await dashboard.start();
          if (!live(epoch)) return;
          render(ctx); // Remove our RPC footer entry; other extensions keep theirs.
          const message = `额度控制台：${url}（仅本机访问；本会话结束后关闭）`;
          if (ctx.hasUI) ctx.ui.notify(message, "info");
          else console.log(message);
        } catch {
          if (!live(epoch)) return;
          dashboard = undefined;
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
        ctx.ui.notify("Use /quota, /quota console, /quota refresh, or /quota interval <60-3600>.", "warning");
        return;
      }
      await updateDailyDate(epoch);
      if (!live(epoch)) return;
      const details = formatDetails(codex, antigravity, sessionTotals, dailyTotals, config.refreshIntervalSeconds);
      if (ctx.hasUI) ctx.ui.notify(details, "info");
      else console.log(details);
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    generation++;
    abortController?.abort();
    abortController = undefined;
    scheduler?.stop();
    scheduler = undefined;
    const closingDashboard = dashboard;
    dashboard = undefined;
    void closingDashboard?.stop();
    delete inFlight["openai-codex"];
    delete inFlight.antigravity;
    currentContext = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
