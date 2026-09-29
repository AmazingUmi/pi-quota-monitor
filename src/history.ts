import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, rm, chmod, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { configDirectory, usageDirectory } from "./config.js";
import { accountId, credential, listAccounts } from "./accounts.js";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ledgerDateMatches } from "./tokens/ledger-date.js";
import { usageIdentity } from "./tokens/identity.js";
import type { TokenUsageRecord } from "./types.js";

const LEDGER = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const backupDir = () => join(configDirectory(), "backups");
const lockPath = () => join(configDirectory(), "ledger.guard");
const deletionsPath = () => join(configDirectory(), "usage-deletions.json");
const deletionKey = (identity: string) => createHash("sha256").update(identity).digest("hex");

async function readUsageDeletions(): Promise<Set<string>> {
  try {
    const path = deletionsPath();
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid usage deletion history.");
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || (data as { schema?: unknown }).schema !== 1
      || !Array.isArray((data as { identities?: unknown }).identities)
      || !(data as { identities: unknown[] }).identities.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))) {
      throw new Error("Invalid usage deletion history.");
    }
    return new Set((data as { identities: string[] }).identities);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}
async function writeUsageDeletions(identities: Set<string>): Promise<void> {
  await atomic(deletionsPath(), JSON.stringify({ schema: 1, identities: [...identities].sort() }) + "\n");
}
/** Called only inside the ledger lock, so a deleted child cannot be reconciled during removal. */
export async function isUsageDeleted(identity: string): Promise<boolean> {
  return (await readUsageDeletions()).has(deletionKey(identity));
}

/** Move pre-usage/ ledgers under the same lock used by append, backup and reset. */
async function migrateLegacyUsage(): Promise<void> {
  const destination = usageDirectory();
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(destination);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Invalid usage directory.");
  await chmod(destination, 0o700);
  for (const entry of await readdir(configDirectory(), { withFileTypes: true })) {
    if (!entry.isFile() || !LEDGER.test(entry.name)) continue;
    const source = join(configDirectory(), entry.name);
    const target = join(destination, entry.name);
    let existing: string;
    try {
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile()) throw new Error("Invalid usage ledger.");
      existing = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(source, target);
      await chmod(target, 0o600);
      continue;
    }
    const incoming = await readFile(source, "utf8");
    // Never turn a trailing partial JSONL entry into a permanent malformed line.
    if ((existing && !existing.endsWith("\n")) || (incoming && !incoming.endsWith("\n"))) {
      throw new Error("Cannot merge incomplete usage ledgers; original files were preserved.");
    }
    const counts = new Map<string, number>();
    for (const line of lines(existing)) counts.set(line, (counts.get(line) ?? 0) + 1);
    const missing: string[] = [];
    for (const line of lines(incoming)) {
      const count = counts.get(line) ?? 0;
      if (count) counts.set(line, count - 1);
      else missing.push(line);
    }
    if (missing.length) await atomic(target, existing + missing.join("\n") + "\n");
    await chmod(target, 0o600);
    // If interrupted after writing the target, the occurrence-count merge is idempotent.
    await rm(source);
  }
}

export async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(lockPath(), "", { flag: "a", mode: 0o600 });
  const release = await lockfile.lock(lockPath(), { realpath: false, stale: 30_000, retries: { retries: 5 } });
  try { await migrateLegacyUsage(); return await fn(); } finally { await release(); }
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
  deletedIdentities?: string[];
}
function validLine(line: string, filename: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const day = filename.slice(6, 16);
    return typeof record.timestamp === "number" && ledgerDateMatches(record.timestamp, day)
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
  for (const entry of await readdir(usageDirectory(), { withFileTypes: true })) {
    if (entry.isFile() && LEDGER.test(entry.name)) ledgers[entry.name] = await readFile(join(usageDirectory(), entry.name), "utf8");
  }
  return { schema: 1, createdAt: new Date().toISOString(), profiles: accounts, ledgers,
    deletedIdentities: [...await readUsageDeletions()].sort() };
}
async function backupLocation(directory?: string): Promise<string> {
  if (directory === undefined) {
    await mkdir(backupDir(), { recursive: true, mode: 0o700 });
    await chmod(backupDir(), 0o700);
    return backupDir();
  }
  if (!isAbsolute(directory) || /[\r\n\u0000]/.test(directory) || directory.trim() !== directory) {
    throw new Error("Backup directory must be an absolute path on the Pi machine.");
  }
  // Do not create or chmod arbitrary paths. A custom directory must already be
  // private; backup files contain OAuth credentials even though each file is 0600.
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Backup directory must be an existing private directory (0700).");
  }
  return realpath(directory);
}
async function backupUnlocked(directory?: string): Promise<string> {
  const destination = await backupLocation(directory);
  const path = join(destination, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  await atomic(path, JSON.stringify(await snapshot()) + "\n");
  return path;
}
export async function backupHistory(directory?: string): Promise<string> {
  return withLedgerLock(() => backupUnlocked(directory));
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
  if (raw.deletedIdentities !== undefined && (!Array.isArray(raw.deletedIdentities)
    || raw.deletedIdentities.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))) throw new Error("Invalid backup.");
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
      const dest = join(usageDirectory(), filename);
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
    const existingDeletions = await readUsageDeletions();
    const mergedDeletions = new Set([...existingDeletions, ...(data.deletedIdentities ?? [])]);
    const updateDeletions = mergedDeletions.size !== existingDeletions.size;
    const created: string[] = [];
    const changed: typeof changes = [];
    try {
      for (const profile of newProfiles) {
        const dest = join(configDirectory(), "accounts", `${profile.name}.json`);
        await atomic(dest, JSON.stringify(profile.credential, null, 2) + "\n");
        created.push(dest);
      }
      for (const change of changes) { await atomic(change.path, change.after); changed.push(change); }
      if (updateDeletions) await writeUsageDeletions(mergedDeletions);
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
async function removeUsageRecords(
  matches: (record: TokenUsageRecord) => boolean, damagedMessage: string,
): Promise<{ backup?: string; removed: number; codexAccountIds: string[]; unassignedCodex: boolean }> {
  return withLedgerLock(async () => {
    const changes: Array<{ path: string; before: string; after: string }> = [];
    const originalDeletions = await readUsageDeletions();
    const deletions = new Set(originalDeletions);
    let removed = 0;
    const codexAccountIds = new Set<string>();
    let unassignedCodex = false;
    for (const entry of await readdir(usageDirectory(), { withFileTypes: true })) {
      if (!entry.isFile() || !LEDGER.test(entry.name)) continue;
      const file = join(usageDirectory(), entry.name);
      const original = await readFile(file, "utf8");
      const rows = lines(original);
      if ((original && !original.endsWith("\n")) || rows.some((line) => !validLine(line, entry.name))) throw new Error(damagedMessage);
      const kept = rows.filter((line) => {
        const record = JSON.parse(line) as TokenUsageRecord;
        if (!matches(record)) return true;
        removed++;
        if (record.provider === "openai-codex") {
          if (record.accountId) codexAccountIds.add(record.accountId);
          else unassignedCodex = true;
        }
        const identity = usageIdentity(record);
        if (identity) deletions.add(deletionKey(identity));
        return false;
      });
      if (kept.length !== rows.length) changes.push({ path: file, before: original, after: kept.length ? kept.join("\n") + "\n" : "" });
    }
    if (!removed) return { removed: 0, codexAccountIds: [], unassignedCodex: false };
    const backup = await backupUnlocked();
    const written: typeof changes = [];
    const changedDeletions = deletions.size !== originalDeletions.size;
    try {
      if (changedDeletions) await writeUsageDeletions(deletions);
      for (const change of changes) { await atomic(change.path, change.after); written.push(change); }
    } catch (error) {
      for (const change of written.reverse()) await atomic(change.path, change.before);
      if (changedDeletions) {
        if (originalDeletions.size) await writeUsageDeletions(originalDeletions);
        else await rm(deletionsPath(), { force: true });
      }
      throw error;
    }
    return { backup, removed, codexAccountIds: [...codexAccountIds], unassignedCodex };
  });
}

/** Delete the visible provider/model row. In account views, only that account's Codex rows are removed. */
export async function deleteModelUsage(provider: string, model: string, accountId?: string): Promise<{
  backup?: string; removed: number; codexAccountIds: string[]; unassignedCodex: boolean;
}> {
  if (!provider || !model) throw new Error("A provider and model are required.");
  return removeUsageRecords((record) => record.provider === provider && record.model === model
    && (accountId === undefined || provider !== "openai-codex" || record.accountId === accountId),
  "Ledger contains an incomplete or damaged line; deletion aborted without changing usage.");
}

export async function resetAccountUsage(id: string): Promise<{ backup: string; removed: number }> {
  if (!id) throw new Error("An account ID is required.");
  const result = await removeUsageRecords((record) => record.provider === "openai-codex" && record.accountId === id,
    "Ledger contains an incomplete or damaged line; reset aborted without changing usage.");
  // Keep the existing reset behavior: even an empty account produces a backup.
  return { removed: result.removed, backup: result.backup ?? await backupHistory() };
}
