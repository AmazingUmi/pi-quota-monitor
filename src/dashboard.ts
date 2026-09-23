import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AntigravityQuota, CodexQuota, MonitorConfig, ProviderCache, TokenTotals } from "./types.js";

export interface DashboardState {
  codex: ProviderCache<CodexQuota>;
  antigravity: ProviderCache<AntigravityQuota>;
  session: TokenTotals;
  daily: TokenTotals;
  config: MonitorConfig;
  updatedAt: number;
}

export interface DashboardActions {
  state(): DashboardState;
  refresh(): Promise<void>;
  setInterval(seconds: number): Promise<void>;
}

const HOST = "127.0.0.1";
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
        reply(res, 200, JSON.stringify({ ...this.actions.state(), control: this.nonce }));
      } else {
        reply(res, 404, JSON.stringify({ error: "Not found" }));
      }
      return;
    }
    if (req.method !== "POST" || !isControlRequest(req, origin, this.nonce)) {
      reply(res, 403, JSON.stringify({ error: "Forbidden" }));
      return;
    }
    if (pathname === "/api/refresh") {
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
