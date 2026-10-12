import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenRecord } from "./collector.js";
import type { TokenUsageRecord } from "../types.js";
import { accountKey, isAccountProvider, stableAccountId } from "../account-identity.js";

interface Child {
  runId?: string;
  sessionFile?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
interface CostReply { version: number; success: boolean; data?: { version: number; children: Child[]; unresolvedAsyncChildren: number } }

/** Read the child session when possible: RPC totals alone have no per-model identity or timing. */
export async function childRecords(child: Child): Promise<TokenUsageRecord[]> {
  if (!child.sessionFile) return [];
  const info = await stat(child.sessionFile);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) return [];
  const rows = (await readFile(child.sessionFile, "utf8")).split("\n");
  const records: TokenUsageRecord[] = [];
  type Identity = { accountId?: string; authType: "oauth" | "api-key" | "unknown" };
  const identities = new Map<string, Identity>(), receipts = new Map<string, Identity>();
  const turnKey = (r: Pick<TokenUsageRecord, "provider" | "model" | "timestamp">) => JSON.stringify([r.provider, r.model, r.timestamp]);
  for (const line of rows) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom" && entry.customType === "quota-monitor:request-account" && isAccountProvider(entry.data?.provider)) {
        const authType = entry.data.authType === "oauth" || entry.data.authType === "api-key" ? entry.data.authType : "unknown";
        const identity = { accountId: authType === "oauth" ? stableAccountId(entry.data.accountId) : undefined, authType };
        if (entry.data.timestamp !== undefined) {
          if (Number.isFinite(entry.data.timestamp) && typeof entry.data.model === "string") receipts.set(turnKey(entry.data), identity);
        } else identities.set(entry.data.provider, identity);
        continue;
      }
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const record = tokenRecord(entry.message);
      if (!record) continue;
      record.source = "pi-subagents";
      record.sessionId = child.sessionFile;
      if (child.runId) record.runId = child.runId;
      if (isAccountProvider(record.provider)) {
        const identity = identities.get(record.provider);
        record.authType = identity?.authType ?? "unknown";
        if (identity?.accountId) { record.accountId = identity.accountId; record.accountKey = accountKey(record.provider, identity.accountId); }
      }
      identities.clear();
      records.push(record);
    } catch { /* A partial last line or malformed entry is not usage. */ }
  }
  for (const record of records) {
    const identity = receipts.get(turnKey(record));
    if (!identity || !isAccountProvider(record.provider)) continue;
    record.authType = identity.authType;
    delete record.accountId; delete record.accountKey;
    if (identity.accountId) { record.accountId = identity.accountId; record.accountKey = accountKey(record.provider, identity.accountId); }
  }
  return records;
}

/** No dependency on pi-subagents: the versioned in-process RPC is optional. */
export function subagentUsage(pi: ExtensionAPI, onRecords: (records: TokenUsageRecord[], incomplete: boolean) => Promise<void>): {
  reconcile(): Promise<void>; dispose(): void;
} {
  let disposed = false;
  let queue = Promise.resolve();
  const pending = new Set<() => void>();
  const reconcile = (): Promise<void> => {
    queue = queue.then(async () => {
      if (disposed) return;
      const requestId = randomUUID();
      const reply = await new Promise<CostReply | undefined>((resolve) => {
        const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (data) => { cleanup(); resolve(data as CostReply); });
        const timeout = setTimeout(() => { cleanup(); resolve(undefined); }, 3000);
        timeout.unref();
        function cleanup() { clearTimeout(timeout); off(); pending.delete(cancel); }
        function cancel() { cleanup(); resolve(undefined); }
        pending.add(cancel);
        pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "cost" });
      });
      if (disposed || !reply?.success || reply.data?.version !== 1 || !Array.isArray(reply.data.children)) return;
      const records: TokenUsageRecord[] = [];
      let incomplete = reply.data.unresolvedAsyncChildren > 0;
      for (const child of reply.data.children) {
        try {
          const rows = await childRecords(child);
          records.push(...rows);
          if (child.usage && [child.usage.input, child.usage.output, child.usage.cacheRead, child.usage.cacheWrite]
            .every((n) => Number.isFinite(n) && n >= 0)) {
            const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
            const delta = Object.fromEntries(fields.map((field) => [field,
              Math.max(0, child.usage![field] - rows.reduce((sum, row) => sum + row[field], 0))])) as
              Pick<TokenUsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">;
            const totalTokens = delta.input + delta.output + delta.cacheRead + delta.cacheWrite;
            if (totalTokens > 0) {
              incomplete = true;
              if (!rows.length && child.runId) records.push({ timestamp: Date.now(), source: "pi-subagents",
                sessionId: child.sessionFile ?? child.runId, runId: child.runId,
                provider: "subagent-unattributed", model: "unknown-subagent", ...delta,
                reasoning: 0, totalTokens });
            }
          }
          if (!child.sessionFile) incomplete = true;
        } catch { incomplete = true; }
      }
      if (!disposed) await onRecords(records, incomplete);
    }).catch(() => {});
    return queue;
  };
  return { reconcile, dispose() { disposed = true; for (const cleanup of pending) cleanup(); } };
}
