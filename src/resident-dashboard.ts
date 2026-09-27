import { QuotaDashboard, type DashboardActions, type DashboardState } from "./dashboard.js";
import { configDirectory } from "./config.js";

/** Static assets are captured when the HTTP server first starts. Increment when the
 * bundled dashboard changes, so /reload does not keep serving an older UI. */
const ASSETS_VERSION = 5;

/** Process-owned socket; session replacement swaps delegates without rebinding the listening port. */
class ResidentDashboard {
  readonly assetsVersion = ASSETS_VERSION;
  private actions?: DashboardActions;
  private owner?: object;
  private snapshots = new Map<string, DashboardState>();
  readonly server = new QuotaDashboard({
    state: async (account) => {
      const actions = this.actions;
      if (actions) {
        const state = await actions.state(account);
        if (this.actions === actions) {
          const snapshot = structuredClone(state);
          this.snapshots.set(account ?? "", snapshot);
          if (state.selectedAccountId) this.snapshots.set(state.selectedAccountId, snapshot);
        }
        return state;
      }
      const state = this.snapshots.get(account ?? "");
      if (!state) throw new Error("Waiting for Pi session");
      return { ...state, context: null, accountNotice: { level: "info", at: state.updatedAt,
        message: "控制台保持运行；等待 Pi 会话连接，当前显示上次读数。" } };
    },
    refresh: () => this.connected().refresh(),
    accountCommand: (command, args) => this.connected().accountCommand!(command, args),
    setInterval: (seconds) => this.connected().setInterval(seconds),
    setPort: (port) => this.connected().setPort(port),
    setStatusbar: (settings) => this.connected().setStatusbar(settings),
  });
  private connected(): DashboardActions {
    if (!this.actions) throw new Error("Waiting for Pi session");
    return this.actions;
  }
  async attach(owner: object, actions: DashboardActions, port: number): Promise<QuotaDashboard> {
    // Obtain an initial snapshot before advertising a running service.
    const state = await actions.state();
    this.owner = owner;
    this.actions = actions;
    this.snapshots.clear();
    const snapshot = structuredClone(state);
    this.snapshots.set("", snapshot);
    if (state.selectedAccountId) this.snapshots.set(state.selectedAccountId, snapshot);
    await this.server.start(port);
    return this.server;
  }
  detach(owner: object): boolean {
    if (this.owner !== owner) return false;
    this.actions = undefined;
    this.owner = undefined;
    return true;
  }
}
const KEY = Symbol.for("pi-quota-monitor.resident-dashboard.v1");
const registry = globalThis as typeof globalThis & { [key: symbol]: Map<string, ResidentDashboard> | undefined };
const residents = registry[KEY] ??= new Map<string, ResidentDashboard>();
export async function attachDashboard(owner: object, actions: DashboardActions, port: number): Promise<QuotaDashboard> {
  const key = configDirectory();
  let resident = residents.get(key);
  if (resident && resident.assetsVersion !== ASSETS_VERSION) {
    // A hot-reloaded extension can still find a server created by the previous
    // module instance. Close it before binding the updated HTML/client assets.
    await resident.server.stop();
    residents.delete(key);
    resident = undefined;
  }
  if (!resident) { resident = new ResidentDashboard(); residents.set(key, resident); }
  try { return await resident.attach(owner, actions, port); }
  catch (error) {
    if (resident.detach(owner)) {
      if (residents.get(key) === resident) residents.delete(key);
      await resident.server.stop();
    }
    throw error;
  }
}
export async function detachDashboard(owner: object, quit: boolean): Promise<void> {
  const key = configDirectory();
  const resident = residents.get(key);
  if (!resident?.detach(owner)) return;
  if (quit) {
    residents.delete(key);
    await resident.server.stop();
  }
}
