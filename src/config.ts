import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MonitorConfig } from "./types.js";

export const DEFAULT_CONFIG: MonitorConfig = {
  refreshIntervalSeconds: 180,
  staleAfterSeconds: 60,
  requestTimeoutSeconds: 10,
  showReset: true,
  showOaiInStatusbar: true,
  showAgyInStatusbar: true,
};

export function configDirectory(): string {
  return join(getAgentDir(), "pi-quota-monitor");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function normalizeConfig(value: unknown): MonitorConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const interval = record.refreshIntervalSeconds;
  const stale = record.staleAfterSeconds;
  const timeout = record.requestTimeoutSeconds;
  return {
    refreshIntervalSeconds: typeof interval === "number" && Number.isInteger(interval) && interval >= 60 && interval <= 3600
      ? interval : DEFAULT_CONFIG.refreshIntervalSeconds,
    staleAfterSeconds: typeof stale === "number" && Number.isInteger(stale) && stale >= 30 && stale <= 600
      ? stale : DEFAULT_CONFIG.staleAfterSeconds,
    requestTimeoutSeconds: typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 3 && timeout <= 30
      ? timeout : DEFAULT_CONFIG.requestTimeoutSeconds,
    showReset: typeof record.showReset === "boolean" ? record.showReset : DEFAULT_CONFIG.showReset,
    // Older config files predate these switches; keep the historical statusbar behavior.
    showOaiInStatusbar: typeof record.showOaiInStatusbar === "boolean" ? record.showOaiInStatusbar : DEFAULT_CONFIG.showOaiInStatusbar,
    showAgyInStatusbar: typeof record.showAgyInStatusbar === "boolean" ? record.showAgyInStatusbar : DEFAULT_CONFIG.showAgyInStatusbar,
  };
}

export async function loadConfig(): Promise<MonitorConfig> {
  try { return normalizeConfig(JSON.parse(await readFile(configPath(), "utf8"))); }
  catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveConfig(config: MonitorConfig): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const path = configPath();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}
