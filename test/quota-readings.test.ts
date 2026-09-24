import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaReadings } from "../src/quota-readings.js";
import type { CodexQuota } from "../src/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "quota-readings-")); directories.push(dir); return dir; }
const quota = (capturedAt: number, remainingPercent = 73): CodexQuota => ({ capturedAt, plan: "plus", fiveHour: { label: "5h", remainingPercent, resetAt: capturedAt + 3600_000 } });

it("records every success, recovers across restarts, and isolates accounts", async () => {
  const root = await fixture();
  const now = Date.now();
  const first = quota(now - 1000, 75), second = quota(now, 73);
  const store = new QuotaReadings("codex", "account-a", root);
  await store.append(first); await store.append(second);
  expect(await new QuotaReadings("codex", "account-a", root).load(now)).toEqual([first, second]);
  expect(await new QuotaReadings("codex", "account-b", root).load(now)).toEqual([]);
  const [scope] = await readdir(join(root, "quota-readings"));
  expect(scope).not.toContain("account-a");
  const folder = join(root, "quota-readings", scope);
  expect((await stat(folder)).mode & 0o777).toBe(0o700);
  expect((await stat(join(folder, "latest.json"))).mode & 0o777).toBe(0o600);
});

it("never replaces the latest snapshot with an older concurrent query and strips extra fields", async () => {
  const root = await fixture();
  const now = Date.now();
  const store = new QuotaReadings("codex", "a", root);
  const newest = { ...quota(now), token: "must-not-store", fiveHour: { ...quota(now).fiveHour!, credential: "must-not-store" } };
  await Promise.all([store.append(newest), store.append(quota(now - 1000))]);
  const [scope] = await readdir(join(root, "quota-readings"));
  const folder = join(root, "quota-readings", scope);
  const content = await readFile(join(folder, "latest.json"), "utf8");
  expect(JSON.parse(content).capturedAt).toBe(now);
  for (const file of await readdir(folder)) expect(await readFile(join(folder, file), "utf8")).not.toContain("must-not-store");
  expect(await store.load(now)).toHaveLength(2);
});

it("recovers valid journal lines after a corrupted snapshot or trailing partial write", async () => {
  const root = await fixture();
  const now = Date.now();
  const store = new QuotaReadings("codex", "a", root);
  await store.append(quota(now));
  const [scope] = await readdir(join(root, "quota-readings"));
  const folder = join(root, "quota-readings", scope);
  const journal = (await readdir(folder)).find((f) => f.endsWith(".jsonl"))!;
  await appendFile(join(folder, journal), '{"capturedAt":');
  await writeFile(join(folder, "latest.json"), "damaged");
  expect(await store.load(now)).toEqual([quota(now)]);
  await store.append(quota(now + 1, 70));
  await writeFile(join(folder, "latest.json"), "damaged");
  expect(await store.load(now + 1)).toEqual([quota(now), quota(now + 1, 70)]);
});

it("retains an older last-known reading for display while loading AGY independently", async () => {
  const root = await fixture();
  const now = Date.now();
  const old = quota(now - 30 * 86400_000);
  const codex = new QuotaReadings("codex", "a", root);
  await codex.append(old);
  expect(await codex.load(now)).toEqual([old]);
  const agy = new QuotaReadings("antigravity", undefined, root);
  const value = { capturedAt: now, groups: [{ name: "Gemini", windows: [quota(now).fiveHour!] }], models: [] };
  await agy.append(value);
  expect(await new QuotaReadings("antigravity", undefined, root).load(now)).toEqual([value]);
});
