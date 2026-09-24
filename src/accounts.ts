import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rename, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { configDirectory } from "./config.js";

const PROVIDER = "openai-codex";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type Credential = Record<string, unknown> & { type: "oauth"; accountId: string };

export function accountId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).accountId;
  return typeof id === "string" && id.trim() && id.length <= 256 ? id : undefined;
}
export function activeAccountId(): string | undefined {
  const credential = readStoredCredential(PROVIDER);
  return credential && credential.type === "oauth" ? accountId(credential) : undefined;
}
export function credential(value: unknown): Credential {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== "oauth" || !accountId(value)
    || typeof (value as Record<string, unknown>).access !== "string" || !(value as Record<string, unknown>).access
    || typeof (value as Record<string, unknown>).refresh !== "string" || !(value as Record<string, unknown>).refresh
    || typeof (value as Record<string, unknown>).expires !== "number"
    || !Number.isFinite((value as Record<string, unknown>).expires)) {
    throw new Error("Only Pi's native Codex OAuth profiles with accountId are supported.");
  }
  return value as Credential;
}
function name(value: string): string {
  if (value === "current" || !NAME.test(value)) throw new Error("Invalid profile name (use letters, digits, dots, underscores or hyphens).");
  return value;
}
const root = () => join(configDirectory(), "accounts");
const profilePath = (label: string) => join(root(), `${name(label)}.json`);
const currentPath = () => join(root(), "current.json");
const authPath = () => join(getAgentDir(), "auth.json");
async function privateWrite(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
async function setup(): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  await chmod(root(), 0o700);
}
async function readProfile(label: string): Promise<Credential> {
  const data: unknown = JSON.parse(await readFile(profilePath(label), "utf8"));
  return credential(data);
}
async function current(): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(currentPath(), "utf8"));
    return typeof data === "string" && NAME.test(data) ? data : undefined;
  } catch { return undefined; }
}
export async function listAccounts(): Promise<{ current?: string; profiles: Array<{ name: string; accountId: string }> }> {
  await setup();
  const entries = await readdir(root(), { withFileTypes: true });
  const profiles: Array<{ name: string; accountId: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "current.json") continue;
    const label = entry.name.slice(0, -5);
    if (!NAME.test(label)) continue;
    try { profiles.push({ name: label, accountId: (await readProfile(label)).accountId }); }
    catch { /* Do not expose contents of damaged credential files. */ }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  const selected = await current();
  const activeId = activeAccountId();
  const matching = profiles.filter((item) => item.accountId === activeId);
  // Native /login and older installs may have no current.json marker. The active
  // OAuth accountId is authoritative; the marker only disambiguates aliases.
  return { current: matching.find((item) => item.name === selected)?.name ?? matching[0]?.name, profiles };
}
export async function saveAccount(label: string): Promise<void> {
  name(label);
  await setup();
  const stored = credential(readStoredCredential(PROVIDER));
  const existing = await listAccounts();
  if (existing.profiles.some((item) => item.name === label && item.accountId !== stored.accountId)) throw new Error("Profile name belongs to another account.");
  await privateWrite(profilePath(label), stored);
  await privateWrite(currentPath(), label);
}

/** Synchronize the currently selected Pi credential, then atomically replace only Codex auth under Pi's own file lock. */
export async function useAccount(label: string): Promise<void> {
  name(label);
  await setup();
  const target = await readProfile(label);
  const path = authPath();
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000, retries: { retries: 5 } });
  try {
    const auth: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("Invalid Pi auth.json.");
    const data = auth as Record<string, unknown>;
    const source = credential(data[PROVIDER]);
    const previous = (await listAccounts()).current;
    if (previous) {
      const saved = await readProfile(previous);
      if (saved.accountId !== source.accountId) throw new Error("Current profile differs from Pi login; save it before switching.");
      await privateWrite(profilePath(previous), source);
    } else if (source.accountId !== target.accountId) {
      throw new Error("Save the current Pi account before switching.");
    }
    if (source.accountId === target.accountId) {
      await privateWrite(currentPath(), label);
      return;
    }
    // Pi's credential store detects the changed auth.json revision on the next request.
    await privateWrite(path, { ...data, [PROVIDER]: target });
    try { await privateWrite(currentPath(), label); }
    catch (error) {
      await privateWrite(path, data);
      throw error;
    }
  } finally { await release(); }
}

export async function deleteAccount(label: string): Promise<void> {
  name(label);
  await setup();
  const target = await readProfile(label);
  if (activeAccountId() === target.accountId) {
    throw new Error("Switch to another account before deleting the active profile.");
  }
  await rm(profilePath(label));
}

export async function importAccount(label: string, sourcePath: string): Promise<void> {
  name(label);
  await setup();
  const data: unknown = JSON.parse(await readFile(sourcePath, "utf8"));
  const imported = credential(data);
  const existing = await listAccounts();
  if (existing.profiles.some((item) => item.name === label)) throw new Error("Profile already exists; import will not overwrite it.");
  await privateWrite(profilePath(label), imported);
}
