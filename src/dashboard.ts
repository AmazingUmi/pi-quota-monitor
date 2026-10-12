import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import type { UsageSummary } from "./tokens/aggregate.js";
import { ACCOUNT_PROVIDERS, isAccountProvider, type AccountProvider } from "./account-identity.js";

export interface DashboardAccount { id: string; name: string; provider?: string; key?: string; note?: string; email?: string; organization?: string; plan?: string; active?: boolean }
export interface DashboardProfile { name: string; accountId?: string; provider?: AccountProvider; key?: string; displayName?: string; current?: boolean }
export interface DashboardCurrentAccount { id: string; name: string; profile?: string; current?: boolean }
import { PRICE_TABLE } from "./tokens/pricing.js";
import { checkDashboardPort, DASHBOARD_HOST as HOST, DEFAULT_DASHBOARD_PORT, isDashboardPort, portErrorMessage } from "./dashboard-port.js";
import type { AntigravityQuota, CardVisibilitySettings, ClaudeQuota, CodexQuota, GrokQuota, MonitorConfig, ProviderCache, QuotaAmountEstimates, TokenTotals } from "./types.js";

export interface DashboardState {
  accounts?: DashboardAccount[];
  currentProfile?: string;
  profiles?: DashboardProfile[];
  currentAccounts?: Partial<Record<AccountProvider, DashboardCurrentAccount>>;
  quotaAccounts?: Partial<Record<AccountProvider, DashboardCurrentAccount>>;
  backups?: string[];
  accountNotice?: { message: string; level: "info" | "warning" | "error"; at: number };
  selectedAccountId?: string;
  currentAccountId?: string;
  codex: ProviderCache<CodexQuota>;
  claude: ProviderCache<ClaudeQuota>;
  grok?: ProviderCache<GrokQuota>;
  antigravity: ProviderCache<AntigravityQuota>;
  usage: UsageSummary;
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  quotaEstimates: QuotaAmountEstimates;
  config: MonitorConfig;
  updatedAt: number;
}

export interface DashboardActions {
  state(accountId?: string): DashboardState | Promise<DashboardState>;
  accountCommand?(command: string, args: string): Promise<void>;
  deleteUsage?(account: string, provider: string, model: string): Promise<{ removed: number }>;
  refresh(): Promise<void>;
  setInterval(seconds: number): Promise<void>;
  setPort(port: number): Promise<void>;
  setCards?(settings: CardVisibilitySettings): Promise<void>;
  setStatusbar(settings: Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showClaudeInStatusbar" | "showAgyInStatusbar" | "showGrokInStatusbar">>): Promise<void>;
}

function publicAccounts(accounts?: DashboardAccount[]): DashboardAccount[] | undefined {
  return accounts?.map(({ id, name, provider, key, note, email, organization, plan, active }) => ({ id, name, provider, key, note, email, organization, plan, active }));
}
function publicProfiles(profiles?: DashboardProfile[]): DashboardProfile[] | undefined {
  return profiles?.map(({ name, accountId, provider, key, displayName, current }) => ({ name, accountId, provider, key, displayName, current }));
}
function publicCurrent(accounts?: Partial<Record<AccountProvider, DashboardCurrentAccount>>) {
  return accounts && Object.fromEntries(ACCOUNT_PROVIDERS.flatMap((p) => {
    const a = accounts[p];
    return a ? [[p, { id: a.id, name: a.name, profile: a.profile, current: a.current }]] : [];
  }));
}
function publicTotals(totals: TokenTotals): TokenTotals {
  const { input, output, reasoning, cacheRead, cacheWrite, totalTokens } = totals;
  return { input, output, reasoning, cacheRead, cacheWrite, totalTokens };
}
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function reply(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  res.end(body);
}

function isControlRequest(req: IncomingMessage, origin: string, nonce: string): boolean {
  return req.headers.origin === origin && req.headers["x-quota-control"] === nonce;
}

async function readSmallJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: HOST, exclusive: true });
  });
}

/** Local-only HTTP server. Its resident owner controls lifetime; no provider credentials are exposed. */
export class QuotaDashboard {
  private server?: Server;
  private starting?: Promise<string>;
  private origin?: string;
  private fallbackFrom?: number;
  private closed = false;
  private readonly nonce = randomBytes(24).toString("hex");

  constructor(private readonly actions: DashboardActions) {}

  get startupNotice(): string | undefined {
    if (!this.origin || this.fallbackFrom === undefined) return undefined;
    return `端口 ${this.fallbackFrom} 已被占用，已自动改用 ${new URL(this.origin).port}。请在控制台「状态与设置」中保存可用端口；原配置未更改。`;
  }

  start(port = DEFAULT_DASHBOARD_PORT): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Dashboard was closed."));
    if (this.origin) return Promise.resolve(this.origin);
    if (this.starting) return this.starting;
    // Port 0 is reserved for internal tests; persisted user settings require a fixed port.
    if (port !== 0 && !isDashboardPort(port)) return Promise.reject(new Error("端口须为 1024–65535 的整数。"));
    this.starting = this.listen(port).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async listen(requestedPort: number): Promise<string> {
    const [html, script, enhance, style, icon] = await Promise.all([
      readFile(new URL("./dashboard/index.html", import.meta.url)),
      readFile(new URL("./dashboard/client.js", import.meta.url)),
      readFile(new URL("./dashboard/enhance.js", import.meta.url)),
      readFile(new URL("./dashboard/style.css", import.meta.url)),
      readFile(new URL("./dashboard/favicon.svg", import.meta.url)),
    ]);
    if (this.closed) throw new Error("Dashboard was closed.");
    const server = createServer((req, res) => {
      void this.handle(req, res, { html, script, enhance, style, icon }).catch(() => {
        if (!res.headersSent) reply(res, 500, JSON.stringify({ error: "Request failed" }));
        else res.destroy();
      });
    });
    this.server = server;
    try {
      try {
        await listenOn(server, requestedPort);
      } catch (error) {
        if (this.closed) throw new Error("Dashboard was closed.");
        if (requestedPort === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw new Error(portErrorMessage(requestedPort, error));
        }
        // Let the OS atomically select and bind a free port; do not overwrite the user's preference.
        try { await listenOn(server, 0); }
        catch (fallbackError) { throw new Error(portErrorMessage(0, fallbackError)); }
        this.fallbackFrom = requestedPort;
      }
      if (this.closed) { server.closeAllConnections(); server.close(); throw new Error("Dashboard was closed."); }
      const port = (server.address() as AddressInfo).port;
      this.origin = `http://${HOST}:${port}`;
      server.unref();
      return this.origin;
    } catch (error) {
      this.server = undefined;
      throw error;
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    assets: { html: Buffer; script: Buffer; enhance: Buffer; style: Buffer; icon: Buffer },
  ): Promise<void> {
    const origin = this.origin;
    if (!origin || req.headers.host !== new URL(origin).host) {
      reply(res, 403, JSON.stringify({ error: "Forbidden" }));
      return;
    }
    // Origin, host and a server-local nonce protect write endpoints from cross-site requests.
    const pathname = new URL(req.url ?? "/", origin).pathname;
    if (req.method === "GET") {
      if (pathname === "/") {
        reply(res, 200, assets.html.toString("utf8"), "text/html; charset=utf-8");
      } else if (pathname === "/client.js") {
        reply(res, 200, assets.script.toString("utf8"), "text/javascript; charset=utf-8");
      } else if (pathname === "/enhance.js") {
        reply(res, 200, assets.enhance.toString("utf8"), "text/javascript; charset=utf-8");
      } else if (pathname === "/style.css") {
        reply(res, 200, assets.style.toString("utf8"), "text/css; charset=utf-8");
      } else if (pathname === "/favicon.svg") {
        reply(res, 200, assets.icon.toString("utf8"), "image/svg+xml; charset=utf-8");
      } else if (pathname === "/api/state") {
        const { accounts, currentProfile, profiles, currentAccounts, quotaAccounts, backups, accountNotice, selectedAccountId, currentAccountId, codex, claude, grok, antigravity, usage, context, quotaEstimates, config, updatedAt } = await this.actions.state(new URL(req.url ?? "/", origin).searchParams.get("account") ?? undefined);
        const summary = {
          totals: publicTotals(usage.totals),
          models: usage.models.map((item) => ({ provider: item.provider, model: item.model, ...publicTotals(item),
            estimatedCostUsd: item.estimatedCostUsd, pricedRecords: item.pricedRecords,
            unpricedRecords: item.unpricedRecords, unpricedTokens: item.unpricedTokens })),
          pricing: { asOf: usage.pricing.asOf, estimatedCostUsd: usage.pricing.estimatedCostUsd,
            pricedRecords: usage.pricing.pricedRecords, unpricedRecords: usage.pricing.unpricedRecords,
            unpricedTokens: usage.pricing.unpricedTokens,
            catalog: PRICE_TABLE.map((row) => ({ provider: row.provider, model: row.model, rates: { ...row.rates },
              source: row.source, ...(row.effectiveFrom ? { effectiveFrom: row.effectiveFrom } : {}), ...(row.longContext ? { longContext: { threshold: row.longContext.threshold, rates: { ...row.longContext.rates } } } : {}) })) },
          records: usage.records, invalidRecords: usage.invalidRecords, childUsageIncomplete: usage.childUsageIncomplete,
          timeline: {
            hours: usage.timeline.hours.map(({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords }) =>
              ({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords })),
            days: usage.timeline.days.map(({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords }) =>
              ({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords })),
            today: usage.timeline.today, currentHour: usage.timeline.currentHour,
          },
          updatedAt: usage.updatedAt, stale: usage.stale, error: usage.error,
        };
        reply(res, 200, JSON.stringify({ accounts: publicAccounts(accounts), currentProfile, profiles: publicProfiles(profiles), currentAccounts: publicCurrent(currentAccounts), quotaAccounts: publicCurrent(quotaAccounts), backups, accountNotice, selectedAccountId, currentAccountId, codex, claude, grok: grok ?? {}, antigravity, usage: summary,
          context: context ? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent } : null,
          quotaEstimates,
          dashboard: { port: Number(new URL(origin).port), ...(this.fallbackFrom !== undefined ? { fallbackFrom: this.fallbackFrom } : {}) },
          config: { dashboardPort: config.dashboardPort, refreshIntervalSeconds: config.refreshIntervalSeconds,
            showOaiInStatusbar: config.showOaiInStatusbar, showClaudeInStatusbar: config.showClaudeInStatusbar, showAgyInStatusbar: config.showAgyInStatusbar, showGrokInStatusbar: config.showGrokInStatusbar,
             showCodexCard: config.showCodexCard !== false, showClaudeCard: config.showClaudeCard !== false,
             showGrokCard: config.showGrokCard !== false, showAgyCard: config.showAgyCard !== false }, updatedAt, control: this.nonce }));
      } else {
        reply(res, 404, JSON.stringify({ error: "Not found" }));
      }
      return;
    }
    if (req.method !== "POST" || !isControlRequest(req, origin, this.nonce)) {
      reply(res, 403, JSON.stringify({ error: "Forbidden" }));
      return;
    }
    if (pathname === "/api/usage-delete") {
      if (!this.actions.deleteUsage) { reply(res, 404, JSON.stringify({ error: "Not found" })); return; }
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { reply(res, 400, JSON.stringify({ error: "Invalid usage selection" })); return; }
      const { account, provider, model } = body as { account?: unknown; provider?: unknown; model?: unknown };
      if (typeof account !== "string" || (account !== "all" && account !== "other" && account !== "unassigned" && !/^(account|provider):[^\r\n\u0000]{1,256}$/.test(account))
        || typeof provider !== "string" || !provider || provider.length > 256
        || typeof model !== "string" || !model || model.length > 256) {
        reply(res, 400, JSON.stringify({ error: "Invalid usage selection" })); return;
      }
      try {
        const result = await this.actions.deleteUsage(account, provider, model);
        reply(res, 200, JSON.stringify({ ok: true, removed: result.removed }));
      } catch {
        reply(res, 409, JSON.stringify({ error: "删除未完成：账本可能已变化、存在损坏记录或无法备份。请检查 Pi 本地数据。" }));
      }
      return;
    }
    if (pathname === "/api/account-command") {
      if (!this.actions.accountCommand) { reply(res, 404, JSON.stringify({ error: "Not found" })); return; }
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { reply(res, 400, JSON.stringify({ error: "Invalid action" })); return; }
      const { command, args } = body as { command?: unknown; args?: unknown };
      const allowed = new Set(["save", "import", "use", "delete", "note", "backup", "restore", "reset-cache", "reset-usage"]);
      if (typeof command !== "string" || !allowed.has(command) || typeof args !== "string" || args.length > 800 || /[\u0000-\u001f\u007f]/.test(args)) {
        reply(res, 400, JSON.stringify({ error: "Invalid account command" })); return;
      }
      const name = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
      const parts = args.split(/\s+/);
      const providerPrefix = isAccountProvider(parts[0]) ? parts.shift()! : undefined;
      const scopedArgs = providerPrefix ? args.slice(providerPrefix.length + 1) : args;
      const valid = command === "save" ? scopedArgs === "" || new RegExp(`^${name}$`).test(scopedArgs)
        : command === "reset-usage" ? new RegExp(`^(?:${name}|account:[a-f0-9]{64})$`).test(scopedArgs)
          : command === "use" || command === "delete" ? new RegExp(`^${name}$`).test(scopedArgs)
        : command === "note" ? /^(?:account:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?: [^\\r\\n\\u0000]{0,120})?$/.test(scopedArgs)
          : command === "import" ? new RegExp(`^${name} \\S.*$`).test(scopedArgs)
            : command === "restore" ? args.trim() === args && args.length > 0 && !providerPrefix
              : command === "backup" ? !providerPrefix && (args === "" || (isAbsolute(args) && args.trim() === args))
                : scopedArgs === "" || (command === "reset-cache" && isAccountProvider(args));
      if (!valid) { reply(res, 400, JSON.stringify({ error: "Invalid account arguments" })); return; }
      await this.actions.accountCommand(command, args);
    } else if (pathname === "/api/refresh") {
      await this.actions.refresh();
    } else if (pathname === "/api/interval") {
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      const seconds = body && typeof body === "object" && "seconds" in body ? (body as { seconds: unknown }).seconds : undefined;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
        reply(res, 400, JSON.stringify({ error: "Interval must be 60–3600 seconds" }));
        return;
      }
      await this.actions.setInterval(seconds);
    } else if (pathname === "/api/port" || pathname === "/api/port-check") {
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      const port = body && typeof body === "object" && !Array.isArray(body) && "port" in body ? body.port : undefined;
      if (!isDashboardPort(port)) {
        reply(res, 400, JSON.stringify({ error: "端口须为 1024–65535 的整数。" })); return;
      }
      const check = await checkDashboardPort(port, Number(new URL(origin).port));
      if (pathname === "/api/port-check") {
        reply(res, 200, JSON.stringify(check)); return;
      }
      if (!check.available) { reply(res, 409, JSON.stringify({ error: check.message })); return; }
      try { await this.actions.setPort(port); }
      catch { reply(res, 500, JSON.stringify({ error: "无法保存端口设置，原设置未更改。" })); return; }
    } else if (pathname === "/api/cards") {
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      const allowed = new Set(["showCodexCard", "showClaudeCard", "showGrokCard", "showAgyCard"]);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        reply(res, 400, JSON.stringify({ error: "Invalid card settings" })); return;
      }
      const entries = Object.entries(body);
      if (!entries.length || entries.some(([key, value]) => !allowed.has(key) || typeof value !== "boolean")) {
        reply(res, 400, JSON.stringify({ error: "Card settings must contain boolean Codex/Claude/Grok/agy options" })); return;
      }
      if (!this.actions.setCards) { reply(res, 503, JSON.stringify({ error: "卡片显示设置暂不可用" })); return; }
      await this.actions.setCards(Object.fromEntries(entries) as CardVisibilitySettings);
    } else if (pathname === "/api/statusbar") {
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      const allowed = new Set(["showOaiInStatusbar", "showClaudeInStatusbar", "showAgyInStatusbar", "showGrokInStatusbar"]);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        reply(res, 400, JSON.stringify({ error: "Invalid statusbar settings" }));
        return;
      }
      const entries = Object.entries(body);
      if (!entries.length || entries.some(([key, value]) => !allowed.has(key) || typeof value !== "boolean")) {
        reply(res, 400, JSON.stringify({ error: "Statusbar settings must contain boolean OAI/CLA/AGY/GRK options" }));
        return;
      }
      await this.actions.setStatusbar(Object.fromEntries(entries) as Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showClaudeInStatusbar" | "showAgyInStatusbar" | "showGrokInStatusbar">>);
    } else {
      reply(res, 404, JSON.stringify({ error: "Not found" }));
      return;
    }
    reply(res, 200, JSON.stringify({ ok: true }));
  }

  async stop(): Promise<void> {
    this.closed = true;
    try { await this.starting; } catch { /* Startup may have failed or been cancelled. */ }
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
