import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childRecords, subagentUsage } from "../src/tokens/subagents.js";
import { appendUsage } from "../src/tokens/store.js";
import { usageDirectory } from "../src/config.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

it("reads model-specific child turns and ignores partial session entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-usage-")); paths.push(dir);
  const file = join(dir, "session.jsonl");
  await writeFile(file, [JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 123,
    provider: "openai-codex", model: "gpt-5", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 } } }), "{partial"].join("\n"));
  expect(await childRecords({ runId: "nested", sessionFile: file })).toMatchObject([{
    source: "pi-subagents", sessionId: file, runId: "nested", model: "gpt-5", totalTokens: 16,
  }]);
});

it("reconciles child RPC usage without counting parent total or duplicating repeated snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-rpc-")); paths.push(dir);
  const file = join(dir, "child.jsonl");
  await writeFile(file, JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 123,
    provider: "openai-codex", model: "gpt-5", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 } } }) + "\n");
  const listeners = new Map<string, (value: unknown) => void>();
  const pi = { events: {
    on: (key: string, handler: (value: unknown) => void) => { listeners.set(key, handler); return () => { listeners.delete(key); }; },
    emit: (_key: string, request: any) => listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ success: true, version: 1,
      data: { version: 1, parent: { input: 999 }, children: [{ runId: "run1", sessionFile: file }], unresolvedAsyncChildren: 0 } }),
  } } as unknown as ExtensionAPI;
  const seen: string[] = [];
  const collector = subagentUsage(pi, async (rows) => { seen.push(...rows.map((row) => `${row.sessionId}:${row.timestamp}`)); });
  await collector.reconcile(); await collector.reconcile(); collector.dispose();
  expect(new Set(seen).size).toBe(1);
  expect(seen).toHaveLength(2); // The ledger, not an RPC snapshot, deduplicates across restarts.
});

it("retains CLI child totals without inventing a model price", async () => {
  const listeners = new Map<string, (value: unknown) => void>();
  const pi = { events: {
    on: (key: string, handler: (value: unknown) => void) => { listeners.set(key, handler); return () => listeners.delete(key); },
    emit: (_key: string, request: any) => listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ success: true,
      data: { version: 1, children: [{ runId: "cli-run", usage: { input: 20, output: 5, cacheRead: 1, cacheWrite: 0 } }], unresolvedAsyncChildren: 0 } }),
  } } as unknown as ExtensionAPI;
  const collected: any[] = [];
  const collector = subagentUsage(pi, async (rows, incomplete) => { collected.push({ rows, incomplete }); });
  await collector.reconcile(); collector.dispose();
  expect(collected[0]).toMatchObject({ incomplete: true, rows: [{ runId: "cli-run", provider: "subagent-unattributed",
    model: "unknown-subagent", totalTokens: 26 }] });
  expect(collected[0].rows[0].estimatedCostUsd).toBeUndefined();
});

it("deduplicates ambient and native child usage under a single session turn", async () => {
  // The test uses the real append path in an isolated PI_CODING_AGENT_DIR.
  const dir = await mkdtemp(join(tmpdir(), "child-ledger-")); paths.push(dir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const record = { timestamp: Date.now(), provider: "openai-codex", model: "gpt-5", sessionId: "/session.jsonl",
      input: 10, output: 3, reasoning: 0, cacheRead: 2, cacheWrite: 1, totalTokens: 16 };
    expect(await appendUsage({ ...record, source: "pi-message" })).toBe(true);
    expect(await appendUsage({ ...record, source: "pi-subagents", runId: "run1" })).toBe(false);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(usageDirectory());
    expect((await readFile(join(usageDirectory(), files[0]), "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});
