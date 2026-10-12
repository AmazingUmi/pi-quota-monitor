import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rename, rm, chmod, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { configDirectory } from "./config.js";
import { queryClaudeAccount } from "./providers/claude.js";
import { grokAccountId } from "./providers/grok.js";
import { ACCOUNT_PROVIDERS, accountKey, accountEmail, displayText, isAccountProvider, jwtClaims, stableAccountId, type AccountProvider } from "./account-identity.js";

export { ACCOUNT_PROVIDERS, PROVIDER_NAMES, isAccountProvider, accountKey, accountViewId } from "./account-identity.js";
export type { AccountProvider } from "./account-identity.js";
const DEFAULT_PROVIDER: AccountProvider = "openai-codex";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export type OAuthCredential = Record<string, unknown> & { type: "oauth"; access: string; refresh: string; expires: number };
export interface AccountIdentity {
  provider: AccountProvider; accountId: string; key: string;
  note?: string; email?: string; organization?: string; plan?: string; firstSeenAt: number;
}
export interface AccountProfile { name: string; provider: AccountProvider; accountId: string; key: string }
export interface SavedProfile { name: string; provider?: AccountProvider; accountId?: string; credential: Record<string, unknown> }
interface Registry { schema: 1; accounts: AccountIdentity[]; bindings: Record<string, string> }
const registryPath = () => join(configDirectory(), "account-identities.json");
const emptyRegistry = (): Registry => ({ schema: 1, accounts: [], bindings: {} });

export function accountId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? stableAccountId((value as Record<string, unknown>).accountId) : undefined;
}
export function credential(value: unknown): OAuthCredential & { accountId: string };
export function credential(value: unknown, provider: AccountProvider): OAuthCredential;
export function credential(value: unknown, provider: AccountProvider = DEFAULT_PROVIDER): OAuthCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Only native Pi OAuth profiles are supported.");
  const v = value as Record<string, unknown>;
  if (v.type !== "oauth" || typeof v.access !== "string" || !v.access || /\s/.test(v.access)
    || typeof v.refresh !== "string" || !v.refresh || typeof v.expires !== "number" || !Number.isFinite(v.expires)) {
    throw new Error("Only native Pi OAuth profiles are supported.");
  }
  if (provider === DEFAULT_PROVIDER && !accountId(value)) throw new Error("Only Pi's native Codex OAuth profiles with accountId are supported.");
  return value as OAuthCredential;
}
function name(value: string): string {
  if (value === "current" || !NAME.test(value)) throw new Error("Invalid profile name (use letters, digits, dots, underscores or hyphens).");
  return value;
}
const root = (provider: AccountProvider = DEFAULT_PROVIDER) => provider === DEFAULT_PROVIDER
  ? join(configDirectory(), "accounts") : join(configDirectory(), "accounts", provider);
export const profilePath = (label: string, provider: AccountProvider = DEFAULT_PROVIDER) => join(root(provider), `${name(label)}.json`);
const currentPath = (provider: AccountProvider) => join(root(provider), "current.json");
const authPath = () => join(getAgentDir(), "auth.json");
async function privateWrite(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}
async function setup(provider: AccountProvider = DEFAULT_PROVIDER): Promise<void> {
  await mkdir(root(provider), { recursive: true, mode: 0o700 });
  await chmod(root(), 0o700);
  await chmod(root(provider), 0o700);
}
function parseRegistry(data: unknown): Registry {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid account registry.");
  const r = data as Registry;
  if (r.schema !== 1 || !Array.isArray(r.accounts) || !r.bindings || typeof r.bindings !== "object" || Array.isArray(r.bindings)) throw new Error("Invalid account registry.");
  const accounts = r.accounts.map((a) => {
    if (!a || !isAccountProvider(a.provider) || !stableAccountId(a.accountId) || a.key !== accountKey(a.provider, a.accountId)
      || !Number.isFinite(a.firstSeenAt)) throw new Error("Invalid account registry.");
    return { provider: a.provider, accountId: a.accountId, key: a.key, firstSeenAt: a.firstSeenAt,
      ...(displayText(a.note) ? { note: displayText(a.note) } : {}), ...(accountEmail(a.email) ? { email: accountEmail(a.email) } : {}),
      ...(displayText(a.organization) ? { organization: displayText(a.organization) } : {}), ...(displayText(a.plan) ? { plan: displayText(a.plan) } : {}) };
  });
  const keys = new Set(accounts.map((a) => a.key));
  return { schema: 1, accounts, bindings: Object.fromEntries(Object.entries(r.bindings)
    .filter(([digest, key]) => /^[a-f0-9]{64}$/.test(digest) && typeof key === "string" && keys.has(key))) };
}
/** Small private allowlisted metadata file; synchronous reads never resolve or expose credentials. */
function registry(strict = false): Registry {
  let fd: number | undefined;
  try {
    fd = openSync(registryPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Invalid account registry.");
    return parseRegistry(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid account registry.");
    return emptyRegistry();
  } finally { if (fd !== undefined) closeSync(fd); }
}
async function modifyRegistry(fn: (data: Registry) => void): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const guard = join(configDirectory(), "account-registry.guard");
  await writeFile(guard, "", { flag: "a", mode: 0o600 });
  const release = await lockfile.lock(guard, { realpath: false, stale: 30_000, retries: { retries: 5, minTimeout: 20 } });
  try {
    const data = registry(true), before = JSON.stringify(data);
    fn(data);
    if (JSON.stringify(data) !== before) await privateWrite(registryPath(), data);
  } finally { await release(); }
}
const bindingKey = (provider: AccountProvider, access: string) => createHash("sha256").update(JSON.stringify([provider, access])).digest("hex");
export function knownCredentialAccount(provider: AccountProvider, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const c = value as Record<string, unknown>;
  if (c.type !== "oauth" || typeof c.access !== "string" || !c.access) return;
  if (provider === DEFAULT_PROVIDER) {
    const id = accountId(c);
    const claims = jwtClaims(c.access), rawAuth = claims?.["https://api.openai.com/auth"];
    const claimed = rawAuth && typeof rawAuth === "object" ? stableAccountId((rawAuth as Record<string, unknown>).chatgpt_account_id) : undefined;
    if (id) return claimed && claimed !== id ? undefined : id;
  }
  if (provider === "xai") return grokAccountId(c.access);
  const data = registry();
  const key = data.bindings[bindingKey(provider, c.access)];
  return data.accounts.find((a) => a.provider === provider && a.key === key)?.accountId;
}
export function activeAccountId(provider: AccountProvider = DEFAULT_PROVIDER): string | undefined {
  return knownCredentialAccount(provider, readStoredCredential(provider));
}
export function accountIdentities(): AccountIdentity[] { return registry().accounts; }
export function accountDisplayName(a: Pick<AccountIdentity, "provider" | "key" | "note" | "email" | "organization">): string {
  return a.note ?? a.email ?? `账号 ${a.key.slice(0, 8)}`;
}
function nativeDetails(provider: AccountProvider, c: OAuthCredential): { email?: string; organization?: string } {
  const claims = jwtClaims(c.access);
  const profile = claims?.["https://api.openai.com/profile"];
  const p = profile && typeof profile === "object" ? profile as Record<string, unknown> : undefined;
  return { email: claims?.email_verified === false ? undefined : accountEmail(p?.email ?? claims?.email),
    organization: provider === "xai" ? displayText(claims?.team_name) : undefined };
}
export async function rememberAccount(provider: AccountProvider, id: string,
  details: { email?: string; organization?: string; plan?: string; note?: string } = {}, access?: string): Promise<AccountIdentity> {
  if (!stableAccountId(id)) throw new Error("Unable to identify this OAuth account.");
  const key = accountKey(provider, id);
  const cached = registry();
  const prior = cached.accounts.find((a) => a.key === key);
  if (prior && (!access || cached.bindings[bindingKey(provider, access)] === key)
    && (["email", "organization", "plan", "note"] as const).every((field) => {
      const value = field === "email" ? accountEmail(details[field]) : displayText(details[field]);
      return !value || value === prior[field];
    })) return prior;
  let result!: AccountIdentity;
  await modifyRegistry((data) => {
    const existing = data.accounts.find((a) => a.key === key);
    result = existing ?? { provider, accountId: id, key, firstSeenAt: Date.now() };
    if (!existing) data.accounts.push(result);
    for (const field of ["email", "organization", "plan", "note"] as const) {
      const value = field === "email" ? accountEmail(details[field]) : displayText(details[field]);
      if (value) result[field] = value;
    }
    if (access) {
      data.bindings[bindingKey(provider, access)] = key;
      // Bound rotating-token lookup history without ever using token hashes as account identities.
      const bindings = Object.entries(data.bindings).filter(([, value]) => value === key);
      for (const [digest] of bindings.slice(0, Math.max(0, bindings.length - 8))) delete data.bindings[digest];
    }
  });
  return result;
}
export async function resolveCredentialAccount(provider: AccountProvider, c: OAuthCredential,
  signal: AbortSignal = AbortSignal.timeout(10_000), timeoutMs = 10_000): Promise<AccountIdentity> {
  const known = knownCredentialAccount(provider, c);
  if (known) return rememberAccount(provider, known, nativeDetails(provider, c), c.access);
  if (provider === "anthropic") {
    const identity = await queryClaudeAccount(c.access, signal, timeoutMs);
    if (identity) return rememberAccount(provider, identity.accountId, identity, c.access);
  }
  throw new Error("Unable to identify this OAuth account.");
}
export async function mergeAccountIdentities(accounts: AccountIdentity[], profiles: SavedProfile[] = []): Promise<void> {
  await modifyRegistry((data) => {
    for (const a of accounts) {
      const old = data.accounts.find((item) => item.key === a.key);
      if (!old) data.accounts.push({ ...a });
      else for (const field of ["note", "email", "organization", "plan"] as const) if (!old[field] && a[field]) old[field] = a[field];
    }
    for (const p of profiles) {
      const provider = p.provider ?? DEFAULT_PROVIDER;
      const id = p.accountId ?? accountId(p.credential);
      if (!id) continue;
      const key = accountKey(provider, id);
      if (!data.accounts.some((a) => a.key === key)) data.accounts.push({ provider, accountId: id, key, firstSeenAt: Date.now() });
      if (typeof p.credential.access === "string") data.bindings[bindingKey(provider, p.credential.access)] = key;
    }
  });
}
export async function setAccountNote(provider: AccountProvider, id: string, note: string): Promise<void> {
  const text = note.trim();
  if (text && !displayText(text)) throw new Error("Account note must be at most 120 characters without control characters.");
  await rememberAccount(provider, id);
  await modifyRegistry((data) => {
    const a = data.accounts.find((a) => a.key === accountKey(provider, id))!;
    if (text) a.note = text; else delete a.note;
  });
}
async function readPrivate(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid account profile.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
export function profileData(value: unknown, provider: AccountProvider): { credential: OAuthCredential; accountId?: string } {
  const wrapper = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (wrapper?.schema === 2) {
    if (wrapper.provider !== provider || !stableAccountId(wrapper.accountId)) throw new Error("Invalid account profile.");
    const c = credential(wrapper.credential, provider);
    const direct = knownCredentialAccount(provider, c);
    if (direct && direct !== wrapper.accountId) throw new Error("Profile identity does not match its credential.");
    return { credential: c, accountId: wrapper.accountId as string };
  }
  const c = credential(value, provider);
  return { credential: c, accountId: knownCredentialAccount(provider, c) };
}
export async function readProfile(label: string, provider: AccountProvider = DEFAULT_PROVIDER): Promise<{ credential: OAuthCredential; accountId: string }> {
  const p = profileData(await readPrivate(profilePath(label, provider)), provider);
  if (!p.accountId) throw new Error("Unable to identify this OAuth account.");
  return { credential: p.credential, accountId: p.accountId };
}
export function storedProfileData(provider: AccountProvider, id: string, c: Record<string, unknown>): unknown {
  return provider === DEFAULT_PROVIDER ? c : { schema: 2, provider, accountId: id, credential: c };
}
async function current(provider: AccountProvider): Promise<string | undefined> {
  try { const data = await readPrivate(currentPath(provider)); return typeof data === "string" && NAME.test(data) ? data : undefined; }
  catch { return; }
}
export async function listAccounts(provider: AccountProvider = DEFAULT_PROVIDER): Promise<{ current?: string; profiles: AccountProfile[] }> {
  await setup(provider);
  const profiles: AccountProfile[] = [];
  for (const entry of await readdir(root(provider), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "current.json") continue;
    const label = entry.name.slice(0, -5);
    if (!NAME.test(label)) continue;
    try { const p = await readProfile(label, provider); profiles.push({ name: label, provider, accountId: p.accountId, key: accountKey(provider, p.accountId) }); }
    catch { /* Never expose damaged credentials. */ }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  const selected = await current(provider);
  const matching = profiles.filter((p) => p.accountId === activeAccountId(provider));
  return { current: matching.find((p) => p.name === selected)?.name ?? matching[0]?.name, profiles };
}
export async function listAllAccounts(): Promise<{ accounts: AccountIdentity[]; profiles: AccountProfile[]; current: Partial<Record<AccountProvider, string>> }> {
  const profiles: AccountProfile[] = [], current: Partial<Record<AccountProvider, string>> = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const c = readStoredCredential(provider);
    const id = knownCredentialAccount(provider, c);
    if (id && c?.type === "oauth") await rememberAccount(provider, id, nativeDetails(provider, c as OAuthCredential), c.access);
    const listed = await listAccounts(provider);
    if (listed.current) current[provider] = listed.current;
    for (const p of listed.profiles) {
      await rememberAccount(provider, p.accountId);
      profiles.push(p);
    }
  }
  return { accounts: accountIdentities(), profiles, current };
}
export async function saveAccount(label: string, provider: AccountProvider = DEFAULT_PROVIDER): Promise<void> {
  name(label); await setup(provider);
  const c = credential(readStoredCredential(provider), provider);
  const identity = await resolveCredentialAccount(provider, c);
  try {
    await lstat(profilePath(label, provider));
    const existing = await readProfile(label, provider);
    if (existing.accountId !== identity.accountId) throw new Error("Profile name belongs to another account.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await privateWrite(profilePath(label, provider), storedProfileData(provider, identity.accountId, c));
  await privateWrite(currentPath(provider), label);
}

/** Switch exactly one provider under Pi's own auth lock. Returned rollback preserves unrelated providers. */
export async function useAccount(label: string, provider: AccountProvider = DEFAULT_PROVIDER): Promise<(expectedAccess?: string) => Promise<void>> {
  name(label); await setup(provider);
  const target = await readProfile(label, provider), path = authPath();
  try { await writeFile(path, "{}\n", { mode: 0o600, flag: "ax" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000, retries: { retries: 5 } });
  let source: unknown, previous: string | undefined;
  try {
    const auth: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("Invalid Pi auth.json.");
    const data = auth as Record<string, unknown>;
    source = data[provider];
    previous = (await listAccounts(provider)).current;
    if (source !== undefined) {
      const c = credential(source, provider), sourceId = knownCredentialAccount(provider, c);
      if (!sourceId || (!previous && sourceId !== target.accountId)) throw new Error("Save the current Pi account before switching.");
      if (previous) {
        const saved = await readProfile(previous, provider);
        if (saved.accountId !== sourceId) throw new Error("Current profile differs from Pi login; save it before switching.");
        // Synchronize every alias so rotated refresh tokens are never left behind in another saved profile.
        for (const p of (await listAccounts(provider)).profiles.filter((p) => p.accountId === sourceId)) {
          await privateWrite(profilePath(p.name, provider), storedProfileData(provider, sourceId, c));
        }
      }
      if (sourceId === target.accountId) {
        await privateWrite(currentPath(provider), label);
        return async () => { if (previous) await privateWrite(currentPath(provider), previous); };
      }
    }
    await rememberAccount(provider, target.accountId);
    await privateWrite(path, { ...data, [provider]: target.credential });
    try { await privateWrite(currentPath(provider), label); }
    catch (error) { await privateWrite(path, data); throw error; }
  } finally { await release(); }
  return async (expectedAccess?: string) => {
    const release = await lockfile.lock(path, { realpath: false, stale: 30_000, retries: { retries: 5 } });
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const current = data[provider] as { access?: unknown } | undefined;
      const unchanged = expectedAccess ? current?.access === expectedAccess
        : current?.access === target.credential.access || knownCredentialAccount(provider, current) === target.accountId;
      if (!unchanged) throw new Error("Credential changed externally; rollback was not applied.");
      if (source === undefined) delete data[provider]; else data[provider] = source;
      await privateWrite(path, data);
      if (previous) await privateWrite(currentPath(provider), previous); else await rm(currentPath(provider), { force: true });
    } finally { await release(); }
  };
}
export async function deleteAccount(label: string, provider: AccountProvider = DEFAULT_PROVIDER): Promise<void> {
  name(label); await setup(provider);
  const p = await readProfile(label, provider);
  let activeId = activeAccountId(provider);
  const active = readStoredCredential(provider);
  if (!activeId && active?.type === "oauth") activeId = (await resolveCredentialAccount(provider, credential(active, provider))).accountId;
  if (activeId === p.accountId) throw new Error("Switch to another account before deleting the active profile.");
  await rememberAccount(provider, p.accountId);
  await rm(profilePath(label, provider));
}
export async function importAccount(label: string, sourcePath: string, provider: AccountProvider = DEFAULT_PROVIDER): Promise<void> {
  name(label); await setup(provider);
  try { await lstat(profilePath(label, provider)); throw new Error("Profile already exists; import will not overwrite it."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parsed = profileData(await readPrivate(sourcePath), provider);
  const identity = await resolveCredentialAccount(provider, parsed.credential);
  if (parsed.accountId && parsed.accountId !== identity.accountId) throw new Error("Profile identity does not match its credential.");
  await privateWrite(profilePath(label, provider), storedProfileData(provider, identity.accountId, parsed.credential));
}
