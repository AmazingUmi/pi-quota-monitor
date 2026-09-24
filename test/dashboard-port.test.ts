import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { checkDashboardPort, DEFAULT_DASHBOARD_PORT, portErrorMessage } from "../src/dashboard-port.js";
import { QuotaDashboard } from "../src/dashboard.js";
import { dashboardFixture } from "./fixtures/dashboard-state.js";

const dashboards: QuotaDashboard[] = [];
const sockets: Server[] = [];
afterEach(async () => {
  await Promise.all(dashboards.splice(0).map((dashboard) => dashboard.stop()));
  await Promise.all(sockets.splice(0).filter((server) => server.listening).map((server) => close(server)));
});
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
async function reserve() {
  const server = createServer((socket) => socket.destroy());
  sockets.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: (server.address() as AddressInfo).port };
}
function fixture() {
  const state = dashboardFixture();
  const setPort = vi.fn(async (port: number) => { state.config.dashboardPort = port; });
  const actions = { state: () => state, refresh: async () => {}, setInterval: async () => {}, setStatusbar: async () => {}, setPort };
  const dashboard = new QuotaDashboard(actions);
  dashboards.push(dashboard);
  return { state, setPort, actions, dashboard };
}
async function controls(dashboard: QuotaDashboard) {
  const origin = await dashboard.start(0);
  const state = await (await fetch(`${origin}/api/state`)).json() as { control: string; dashboard: { port: number } };
  const headers = { Origin: origin, "X-Quota-Control": state.control, "Content-Type": "application/json" };
  const post = (path: string, port: unknown, override = headers) => fetch(`${origin}${path}`, { method: "POST", headers: override, body: JSON.stringify({ port }) });
  return { origin, post, headers, runningPort: state.dashboard.port };
}

it("migrates old configs to a fixed default and rejects invalid port values", () => {
  expect(normalizeConfig({}).dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
  for (const value of [undefined, null, 0, -1, 1023, 65536, 3000.5, "38457", true]) {
    expect(normalizeConfig({ dashboardPort: value }).dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
  }
  for (const value of [1024, 3000, 65535]) expect(normalizeConfig({ dashboardPort: value }).dashboardPort).toBe(value);
  expect(portErrorMessage(3000, { code: "EACCES" })).toContain("没有权限");
});

it("detects occupancy and releases a successful probe instead of reserving the port", async () => {
  const { server, port } = await reserve();
  expect(await checkDashboardPort(port)).toMatchObject({ available: false, message: expect.stringContaining("已被占用") });
  await close(server);
  expect(await checkDashboardPort(port)).toMatchObject({ available: true });
  expect(await checkDashboardPort(port)).toMatchObject({ available: true });
  await expect(checkDashboardPort(0)).rejects.toThrow("1024–65535");
});

it("saves a checked port for the next launch without rebinding the current dashboard", async () => {
  const { dashboard, state, actions, setPort } = fixture();
  const { origin, post, runningPort } = await controls(dashboard);
  expect(Number(new URL(origin).port)).toBe(runningPort);
  expect(await (await post("/api/port-check", runningPort)).json()).toMatchObject({ available: true, message: expect.stringContaining("当前控制台") });
  expect((await post("/api/port", runningPort)).status).toBe(200);
  expect(setPort).toHaveBeenLastCalledWith(runningPort);
  const target = await reserve();
  await close(target.server);
  expect(await (await post("/api/port-check", target.port)).json()).toMatchObject({ available: true });
  expect(state.config.dashboardPort).toBe(runningPort);
  expect((await post("/api/port", target.port)).status).toBe(200);
  expect(state.config.dashboardPort).toBe(target.port);
  expect(await dashboard.start(target.port)).toBe(origin);
  const payload = await (await fetch(`${origin}/api/state`)).json();
  expect(payload).toMatchObject({ config: { dashboardPort: target.port }, dashboard: { port: runningPort } });
  await dashboard.stop();
  const next = new QuotaDashboard(actions);
  dashboards.push(next);
  expect(await next.start(state.config.dashboardPort)).toBe(`http://127.0.0.1:${target.port}`);
});

it("blocks saving an occupied port but automatically starts on a free port with a notice", async () => {
  const target = await reserve();
  const { dashboard, state, setPort } = fixture();
  const { post } = await controls(dashboard);
  expect(await (await post("/api/port-check", target.port)).json()).toMatchObject({ available: false, message: expect.stringContaining(String(target.port)) });
  const conflict = await post("/api/port", target.port);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: expect.stringContaining("已被占用") });
  expect(setPort).not.toHaveBeenCalled();
  expect(state.config.dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
  const { dashboard: next, state: nextState, setPort: nextSetPort, actions } = fixture();
  nextState.config.dashboardPort = target.port;
  const [url, sameUrl] = await Promise.all([next.start(target.port), next.start(target.port)]);
  expect(sameUrl).toBe(url);
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const fallbackPort = Number(new URL(url).port);
  expect(fallbackPort).not.toBe(target.port);
  expect(next.startupNotice).toContain(`端口 ${target.port} 已被占用`);
  expect(next.startupNotice).toContain(String(fallbackPort));
  expect(next.startupNotice).toContain("状态与设置");
  const payload = await (await fetch(`${url}/api/state`)).json();
  expect(payload).toMatchObject({ dashboard: { port: fallbackPort, fallbackFrom: target.port }, config: { dashboardPort: target.port } });
  expect(nextSetPort).not.toHaveBeenCalled();
  expect((await fetch(`${url}/api/port`, { method: "POST", headers: { Origin: "https://evil.example", "X-Quota-Control": payload.control }, body: JSON.stringify({ port: fallbackPort }) })).status).toBe(403);
  await next.stop();
  expect(next.startupNotice).toBeUndefined();
  await expect(fetch(`${url}/api/state`)).rejects.toThrow();
  await close(target.server);
  const retry = new QuotaDashboard(actions);
  dashboards.push(retry);
  expect(await retry.start(target.port)).toBe(`http://127.0.0.1:${target.port}`);
  expect(retry.startupNotice).toBeUndefined();
});

it("authenticates and validates both port endpoints, and leaves settings intact on write failure", async () => {
  const { dashboard, state, setPort } = fixture();
  const { origin, post, headers, runningPort } = await controls(dashboard);
  for (const path of ["/api/port", "/api/port-check"]) {
    for (const value of [null, 0, -1, 1023, 65536, 3000.1, "3000", true, [], {}]) {
      expect((await post(path, value)).status).toBe(400);
    }
    expect((await post(path, runningPort, { ...headers, Origin: "https://example.com" })).status).toBe(403);
    expect((await post(path, runningPort, { ...headers, "X-Quota-Control": "" })).status).toBe(403);
    expect((await fetch(`${origin}${path}`, { method: "POST", headers, body: "{" })).status).toBe(400);
  }
  expect(setPort).not.toHaveBeenCalled();
  setPort.mockRejectedValueOnce(new Error("disk full"));
  expect((await post("/api/port", runningPort)).status).toBe(500);
  expect(state.config.dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
});
