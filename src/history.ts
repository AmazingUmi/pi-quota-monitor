import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { configDirectory } from "./config.js";
import { accountId, credential, listAccounts } from "./accounts.js";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const LEDGER = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const backupDir = () => join(configDirectory(), "backups");
const lockPath = () => join(configDirectory(), "ledger.guard");

export async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(lockPath(), "", { flag: "a", mode: 0o600 });
  const release = await lockfile.lock(lockPath(), { realpath: false, stale: 30_000, retries: { retries: 5 } });
  try { return await fn(); } finally { await release(); }
}

async function atomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}
interface Snapshot {
  schema: 1;
  createdAt: string;
  profiles: Array<{ name: string; credential: Record<string, unknown> }>;
  ledgers: Record<string, string>;
}
function validLine(line: string, filename: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const day = filename.slice(6, 16);
    return typeof record.timestamp === "number" && Number.isFinite(record.timestamp) && localDate(record.timestamp) === day
      && typeof record.provider === "string" && !!record.provider
      && typeof record.model === "string" && !!record.model
      && (record.accountId === undefined || accountId(record) !== undefined)
      && ["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"]
        .every((key) => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0);
  } catch { return false; }
}
function lines(text: string): string[] { return text.split("\n").filter(Boolean); }
async function snapshot(): Promise<Snapshot> {
  const { profiles } = await listAccounts();
  const accounts: Snapshot["profiles"] = [];
  const active = readStoredCredential("openai-codex");
  const { current } = await listAccounts();
  for (const profile of profiles) {
    const saved = JSON.parse(await readFile(join(configDirectory(), "accounts", `${profile.name}.json`), "utf8")) as Record<string, unknown>;
    const credential = profile.name === current && accountId(active) === profile.accountId ? active as Record<string, unknown> : saved;
    accounts.push({ name: profile.name, credential });
  }
  const ledgers: Record<string, string> = {};
  for (const entry of await readdir(configDirectory(), { withFileTypes: true })) {
    if (entry.isFile() && LEDGER.test(entry.name)) ledgers[entry.name] = await readFile(join(configDirectory(), entry.name), "utf8");
  }
  return { schema: 1, createdAt: new Date().toISOString(), profiles: accounts, ledgers };
}
async function backupUnlocked(): Promise<string> {
  await mkdir(backupDir(), { recursive: true, mode: 0o700 });
  await chmod(backupDir(), 0o700);
  const path = join(backupDir(), `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  await atomic(path, JSON.stringify(await snapshot()) + "\n");
  return path;
}
export async function backupHistory(): Promise<string> {
  return withLedgerLock(backupUnlocked);
}
export async function listBackups(): Promise<string[]> {
  await mkdir(backupDir(), { recursive: true, mode: 0o700 });
  await chmod(backupDir(), 0o700);
  return (await readdir(backupDir())).filter((name) => /^backup-[\w-]+\.json$/.test(name)).sort().reverse().map((name) => join(backupDir(), name));
}
function parseSnapshot(data: unknown): Snapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid backup.");
  const raw = data as Partial<Snapshot>;
  if (raw.schema !== 1 || !Array.isArray(raw.profiles) || !raw.ledgers || typeof raw.ledgers !== "object" || Array.isArray(raw.ledgers)) throw new Error("Unsupported backup format.");
  const names = new Set<string>();
  for (const profile of raw.profiles) {
    if (!profile || typeof profile.name !== "string" || !PROFILE.test(profile.name) || profile.name === "current"
      || names.has(profile.name)) throw new Error("Invalid backup profile.");
    names.add(profile.name);
    credential(profile.credential);
  }
  for (const [filename, content] of Object.entries(raw.ledgers)) {
    if (!LEDGER.test(filename) || typeof content !== "string" || lines(content).some((line) => !validLine(line, filename))) throw new Error("Invalid backup ledger.");
  }
  return raw as Snapshot;
}
/** Merge records by occurrence count, so restoring a backup twice never doubles usage. */
export async function inspectHistory(path: string): Promise<{ profiles: string[]; records: number }> {
  const data = parseSnapshot(JSON.parse(await readFile(path, "utf8")));
  return { profiles: data.profiles.map((profile) => profile.name),
    records: Object.values(data.ledgers).reduce((sum, content) => sum + lines(content).length, 0) };
}

export async function importHistory(path: string): Promise<{ profiles: number; records: number }> {
  const data = parseSnapshot(JSON.parse(await readFile(path, "utf8")));
  return withLedgerLock(async () => {
    const existing = await listAccounts();
    for (const profile of data.profiles) {
      const match = existing.profiles.find((item) => item.name === profile.name);
      if (match && match.accountId !== accountId(profile.credential)) throw new Error("Profile name conflict; import aborted.");
    }
    const newProfiles = data.profiles.filter((profile) => !existing.profiles.some((item) => item.name === profile.name));
    const changes: Array<{ path: string; before: string | undefined; after: string }> = [];
    let records = 0;
    for (const [filename, content] of Object.entries(data.ledgers)) {
      const dest = join(configDirectory(), filename);
      let previous: string | undefined;
      try { previous = await readFile(dest, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const counts = new Map<string, number>();
      for (const line of lines(previous ?? "")) counts.set(line, (counts.get(line) ?? 0) + 1);
      const missing: string[] = [];
      for (const line of lines(content)) {
        const count = counts.get(line) ?? 0;
        if (count) counts.set(line, count - 1);
        else missing.push(line);
      }
      if (missing.length) {
        const prefix = previous ?? "";
        changes.push({ path: dest, before: previous,
          after: (prefix.endsWith("\n") || !prefix ? prefix : prefix + "\n") + missing.join("\n") + "\n" });
        records += missing.length;
      }
    }
    const created: string[] = [];
    const changed: typeof changes = [];
    try {
      for (const profile of newProfiles) {
        const dest = join(configDirectory(), "accounts", `${profile.name}.json`);
        await atomic(dest, JSON.stringify(profile.credential, null, 2) + "\n");
        created.push(dest);
      }
      for (const change of changes) { await atomic(change.path, change.after); changed.push(change); }
    } catch (error) {
      for (const change of changed.reverse()) {
        if (change.before === undefined) await rm(change.path, { force: true });
        else await atomic(change.path, change.before);
      }
      for (const dest of created) await rm(dest, { force: true });
      throw error;
    }
    return { profiles: newProfiles.length, records };
  });
}
export async function resetAccountUsage(id: string): Promise<{ backup: string; removed: number }> {
  if (!id) throw new Error("An account ID is required.");
  return withLedgerLock(async () => {
    const changes: Array<{ path: string; before: string; after: string }> = [];
    let removed = 0;
    for (const entry of await readdir(configDirectory(), { withFileTypes: true })) {
      if (!entry.isFile() || !LEDGER.test(entry.name)) continue;
      const file = join(configDirectory(), entry.name);
      const original = await readFile(file, "utf8");
      const rows = lines(original);
      if ((original && !original.endsWith("\n")) || rows.some((line) => !validLine(line, entry.name))) {
        throw new Error("Ledger contains an incomplete or damaged line; reset aborted without changing usage.");
      }
      const kept = rows.filter((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.provider === "openai-codex" && record.accountId === id) { removed++; return false; }
        return true;
      });
      if (kept.length !== rows.length) changes.push({ path: file, before: original, after: kept.length ? kept.join("\n") + "\n" : "" });
    }
    const backup = await backupUnlocked();
    const written: typeof changes = [];
    try { for (const change of changes) { await atomic(change.path, change.after); written.push(change); } }
    catch (error) {
      for (const change of written.reverse()) await atomic(change.path, change.before);
      throw error;
    }
    return { backup, removed };
  });
}
