import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import type { UsageSummary } from "./tokens/aggregate.js";
import { PRICE_TABLE } from "./tokens/pricing.js";
import type { AntigravityQuota, CodexQuota, MonitorConfig, ProviderCache, QuotaAmountEstimates, TokenTotals } from "./types.js";

export interface DashboardState {
  accounts?: Array<{ id: string; name: string }>;
  currentProfile?: string;
  profiles?: Array<{ name: string; accountId: string }>;
  backups?: string[];
  accountNotice?: { message: string; level: "info" | "warning" | "error"; at: number };
  selectedAccountId?: string;
  currentAccountId?: string;
  codex: ProviderCache<CodexQuota>;
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
  refresh(): Promise<void>;
  setInterval(seconds: number): Promise<void>;
  setStatusbar(settings: Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showAgyInStatusbar">>): Promise<void>;
}

const HOST = "127.0.0.1";
function publicTotals(totals: TokenTotals): TokenTotals {
  const { input, output, reasoning, cacheRead, cacheWrite, totalTokens } = totals;
  return { input, output, reasoning, cacheRead, cacheWrite, totalTokens };
}
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

/** Local-only, session-scoped HTTP server. It never receives or returns provider credentials. */
export class QuotaDashboard {
  private server?: Server;
  private starting?: Promise<string>;
  private origin?: string;
  private closed = false;
  private readonly nonce = randomBytes(24).toString("hex");

  constructor(private readonly actions: DashboardActions) {}

  start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Dashboard was closed."));
    if (this.origin) return Promise.resolve(this.origin);
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async listen(): Promise<string> {
    const [html, script, style] = await Promise.all([
      readFile(new URL("./dashboard/index.html", import.meta.url)),
      readFile(new URL("./dashboard/client.js", import.meta.url)),
      readFile(new URL("./dashboard/style.css", import.meta.url)),
    ]);
    if (this.closed) throw new Error("Dashboard was closed.");
    const server = createServer((req, res) => {
      void this.handle(req, res, { html, script, style }).catch(() => {
        if (!res.headersSent) reply(res, 500, JSON.stringify({ error: "Request failed" }));
        else res.destroy();
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, HOST, () => { server.off("error", reject); resolve(); });
      });
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
    assets: { html: Buffer; script: Buffer; style: Buffer },
  ): Promise<void> {
    const origin = this.origin;
    if (!origin || req.headers.host !== new URL(origin).host) {
      reply(res, 403, JSON.stringify({ error: "Forbidden" }));
      return;
    }
    // Origin, host and a session-local nonce protect write endpoints from cross-site requests.
    const pathname = new URL(req.url ?? "/", origin).pathname;
    if (req.method === "GET") {
      if (pathname === "/") {
        reply(res, 200, assets.html.toString("utf8"), "text/html; charset=utf-8");
      } else if (pathname === "/client.js") {
        reply(res, 200, assets.script.toString("utf8"), "text/javascript; charset=utf-8");
      } else if (pathname === "/style.css") {
        reply(res, 200, assets.style.toString("utf8"), "text/css; charset=utf-8");
      } else if (pathname === "/api/state") {
        const { accounts, currentProfile, profiles, backups, accountNotice, selectedAccountId, currentAccountId, codex, antigravity, usage, context, quotaEstimates, config, updatedAt } = await this.actions.state(new URL(req.url ?? "/", origin).searchParams.get("account") ?? undefined);
        const summary = {
          totals: publicTotals(usage.totals),
          models: usage.models.map((item) => ({ provider: item.provider, model: item.model, ...publicTotals(item),
            estimatedCostUsd: item.estimatedCostUsd, pricedRecords: item.pricedRecords,
            unpricedRecords: item.unpricedRecords, unpricedTokens: item.unpricedTokens })),
          pricing: { asOf: usage.pricing.asOf, estimatedCostUsd: usage.pricing.estimatedCostUsd,
            pricedRecords: usage.pricing.pricedRecords, unpricedRecords: usage.pricing.unpricedRecords,
            unpricedTokens: usage.pricing.unpricedTokens,
            catalog: PRICE_TABLE.map((row) => ({ provider: row.provider, model: row.model, rates: { ...row.rates },
              source: row.source, ...(row.longContext ? { longContext: { threshold: row.longContext.threshold, rates: { ...row.longContext.rates } } } : {}) })) },
          records: usage.records, invalidRecords: usage.invalidRecords,
          timeline: {
            hours: usage.timeline.hours.map(({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords }) =>
              ({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords })),
            days: usage.timeline.days.map(({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords }) =>
              ({ bucket, provider, model, totalTokens, estimatedCostUsd, pricedRecords, unpricedRecords })),
            today: usage.timeline.today, currentHour: usage.timeline.currentHour,
          },
          updatedAt: usage.updatedAt, stale: usage.stale, error: usage.error,
        };
        reply(res, 200, JSON.stringify({ accounts, currentProfile, profiles, backups, accountNotice, selectedAccountId, currentAccountId, codex, antigravity, usage: summary,
          context: context ? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent } : null,
          quotaEstimates,
          config: { refreshIntervalSeconds: config.refreshIntervalSeconds,
            showOaiInStatusbar: config.showOaiInStatusbar, showAgyInStatusbar: config.showAgyInStatusbar }, updatedAt, control: this.nonce }));
      } else {
        reply(res, 404, JSON.stringify({ error: "Not found" }));
      }
      return;
    }
    if (req.method !== "POST" || !isControlRequest(req, origin, this.nonce)) {
      reply(res, 403, JSON.stringify({ error: "Forbidden" }));
      return;
    }
    if (pathname === "/api/account-command") {
      if (!this.actions.accountCommand) { reply(res, 404, JSON.stringify({ error: "Not found" })); return; }
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { reply(res, 400, JSON.stringify({ error: "Invalid action" })); return; }
      const { command, args } = body as { command?: unknown; args?: unknown };
      const allowed = new Set(["save", "import", "use", "delete", "backup", "restore", "reset-cache", "reset-usage"]);
      if (typeof command !== "string" || !allowed.has(command) || typeof args !== "string" || args.length > 800 || /[\r\n\u0000]/.test(args)) {
        reply(res, 400, JSON.stringify({ error: "Invalid account command" })); return;
      }
      const name = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
      const valid = command === "save" || command === "use" || command === "delete" || command === "reset-usage"
        ? new RegExp(`^${name}$`).test(args)
        : command === "import" ? new RegExp(`^${name} \\S.*$`).test(args)
          : command === "restore" ? args.trim() === args && args.length > 0
            : command === "backup" ? args === "" || (isAbsolute(args) && args.trim() === args) : args === "";
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
    } else if (pathname === "/api/statusbar") {
      let body: unknown;
      try { body = await readSmallJson(req); }
      catch { reply(res, 400, JSON.stringify({ error: "Invalid JSON" })); return; }
      const allowed = new Set(["showOaiInStatusbar", "showAgyInStatusbar"]);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        reply(res, 400, JSON.stringify({ error: "Invalid statusbar settings" }));
        return;
      }
      const entries = Object.entries(body);
      if (!entries.length || entries.some(([key, value]) => !allowed.has(key) || typeof value !== "boolean")) {
        reply(res, 400, JSON.stringify({ error: "Statusbar settings must contain boolean OAI/AGY options" }));
        return;
      }
      await this.actions.setStatusbar(Object.fromEntries(entries) as Partial<Pick<MonitorConfig, "showOaiInStatusbar" | "showAgyInStatusbar">>);
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
