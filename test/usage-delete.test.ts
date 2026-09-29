import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageDirectory, configDirectory } from "../src/config.js";
import { backupHistory, deleteModelUsage, importHistory } from "../src/history.js";
import { UsageAggregator } from "../src/tokens/aggregate.js";
import { appendUsage, localDate } from "../src/tokens/store.js";
import type { TokenUsageRecord } from "../src/types.js";

const previous = process.env.PI_CODING_AGENT_DIR;
const directories: string[] = [];
afterEach(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "quota-delete-"));
  directories.push(root);
  process.env.PI_CODING_AGENT_DIR = root;
  const file = join(usageDirectory(), `usage-${localDate(Date.now())}.jsonl`);
  await mkdir(usageDirectory(), { recursive: true });
  return file;
}
function row(provider: string, model: string, extra: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return { timestamp: Date.now() - 30_000, provider, model, input: 10, output: 2, reasoning: 1,
    cacheRead: 0, cacheWrite: 0, totalTokens: 12, ...extra };
}

it("deletes just the selected model/account records, updates both ledger views, and restores from the automatic backup", async () => {
  const file = await setup();
  const pro = row("openai-codex", "gpt-6-sol", { accountId: "pro", sessionId: "pro-session" });
  const plus = row("openai-codex", "gpt-6-sol", { accountId: "plus", sessionId: "plus-session" });
  const legacy = row("openai-codex", "gpt-6-sol");
  const shared = row("antigravity", "gemini-3.8-flash");
  for (const record of [pro, plus, legacy, shared]) await appendUsage(record);
  const overall = new UsageAggregator();
  const proView = new UsageAggregator(undefined, "pro");
  await overall.refresh(); await proView.refresh();
  expect(overall.state().records).toBe(4);
  expect(proView.state().records).toBe(2);
  const result = await deleteModelUsage("openai-codex", "gpt-6-sol", "pro");
  expect(result.removed).toBe(1);
  expect(result.backup).toContain("backup-");
  expect((await stat(result.backup!)).mode & 0o777).toBe(0o600);
  const backup = JSON.parse(await readFile(result.backup!, "utf8")) as { ledgers: Record<string, string> };
  expect(Object.values(backup.ledgers).join("\n")).toContain('"accountId":"pro"');
  await overall.refresh(); await proView.refresh();
  expect(overall.state()).toMatchObject({ records: 3, totals: { totalTokens: 36 }, pricing: { pricedRecords: 3 } });
  expect(proView.state()).toMatchObject({ records: 1, totals: { totalTokens: 12 } });
  expect(overall.state().timeline.days.reduce((sum, item) => sum + item.totalTokens, 0)).toBe(36);
  expect(proView.estimateCostForPeriod("openai-codex", Date.now() - 60_000).totalTokens).toBe(0);
  expect((await readFile(file, "utf8"))).not.toContain('"accountId":"pro"');
  expect(await appendUsage(pro)).toBe(false); // Reconciliation must not undo deletion.
  expect(await appendUsage({ ...pro, timestamp: Date.now(), input: 11, totalTokens: 13 })).toBe(true); // New turn.
  expect((await importHistory(result.backup!)).records).toBe(1);
  await overall.refresh();
  expect(overall.state().records).toBe(5);
});

it("removes unattributed CLI child receipts without guessing their model or re-adding deleted run IDs", async () => {
  const file = await setup();
  const deleted = row("subagent-unattributed", "unknown-subagent", { source: "pi-subagents", sessionId: "run-a", runId: "run-a" });
  const another = row("subagent-unattributed", "unknown-subagent", { source: "pi-subagents", sessionId: "run-b", runId: "run-b" });
  const retained = row("openai-codex", "gpt-6-sol", { accountId: "pro" });
  await appendUsage(deleted); await appendUsage(another); await appendUsage(retained);
  const scoped = await deleteModelUsage("subagent-unattributed", "unknown-subagent", "pro");
  expect(scoped.removed).toBe(2); // Shared rows are not account-scoped.
  expect((await readFile(file, "utf8"))).toContain("gpt-6-sol");
  expect((await readFile(join(configDirectory(), "usage-deletions.json"), "utf8"))).not.toContain("run-a"); // Hashes, not session paths.
  expect(await appendUsage(deleted)).toBe(false);
  expect(await appendUsage(another)).toBe(false);
  expect((await deleteModelUsage("subagent-unattributed", "unknown-subagent")).removed).toBe(0);
  expect(await appendUsage(row("subagent-unattributed", "unknown-subagent", { source: "pi-subagents", sessionId: "run-c", runId: "run-c" }))).toBe(true);
  const view = new UsageAggregator();
  await view.refresh();
  expect(view.state().models.map(({ provider, model }) => [provider, model])).toEqual([
    ["openai-codex", "gpt-6-sol"], ["subagent-unattributed", "unknown-subagent"],
  ]);
});

it("retains deleted child identities when a later backup is imported into a new Pi data directory", async () => {
  await setup();
  const child = row("subagent-unattributed", "unknown-subagent", { source: "pi-subagents", sessionId: "cli-run", runId: "cli-run" });
  await appendUsage(child);
  await deleteModelUsage(child.provider, child.model);
  const backup = await backupHistory();
  await setup();
  expect((await importHistory(backup)).records).toBe(0);
  expect(await appendUsage(child)).toBe(false);
  expect(await appendUsage({ ...child, sessionId: "new-run", runId: "new-run" })).toBe(true);
});

it("aborts deletion without altering any ledger when another file is damaged", async () => {
  const file = await setup();
  const original = JSON.stringify(row("subagent-unattributed", "unknown-subagent")) + "\n";
  await writeFile(file, original);
  await writeFile(join(usageDirectory(), "usage-2000-01-01.jsonl"), "{broken}\n");
  await expect(deleteModelUsage("subagent-unattributed", "unknown-subagent")).rejects.toThrow("damaged");
  expect(await readFile(file, "utf8")).toBe(original);
  await expect(readFile(join(configDirectory(), "usage-deletions.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
