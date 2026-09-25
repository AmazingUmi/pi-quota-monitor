import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceCodexPeriods, CodexPeriodStore } from "../src/codex-periods.js";
import type { CodexQuota, QuotaAmountEstimates } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const start = Date.parse("2026-09-23T12:00:00Z");
const resetAt = start + 7 * 86_400_000;
const quota = (capturedAt: number, weekly: number, fiveHour = 80, reset = resetAt): CodexQuota => ({
  capturedAt, plan: "pro", weekly: { label: "weekly", remainingPercent: weekly, resetAt: reset },
  fiveHour: { label: "5h", remainingPercent: fiveHour, resetAt: start + 5 * 3_600_000 },
});
const estimates = (end: number, total: number): QuotaAmountEstimates["codex"] => ({
  weekly: { note: "estimated", estimatedPeriodUsd: total, sampleStartAt: start, sampleEndAt: end, usedPercent: 10, piAttributedPercent: 10, calibrationPercent: 10, attribution: "verified" },
  fiveHour: { note: "unavailable" },
});

it("splits early/manual increases even with unchanged resetAt and keeps independent OAI windows", () => {
  let periods = advanceCodexPeriods([], [quota(start, 90), quota(start + 60_000, 80)], estimates(start + 60_000, 80));
  expect(periods.find((p) => p.kind === "weekly")).toMatchObject({ startedAt: start, estimatedTotalUsd: 80 });
  periods = advanceCodexPeriods(periods, [quota(start + 120_000, 100)], estimates(start + 60_000, 80));
  expect(periods.filter((p) => p.kind === "weekly")).toHaveLength(2);
  expect(periods[0]).toMatchObject({ kind: "fiveHour", startedAt: start });
  expect(periods[0].closedAt).toBeUndefined();
  expect(periods.find((p) => p.kind === "weekly" && p.startedAt === start)).toMatchObject({ closedAt: start + 120_000, boundary: "increase", estimatedTotalUsd: 80 });
  expect(periods.find((p) => p.kind === "weekly" && p.startedAt === start + 120_000)?.estimatedTotalUsd).toBeUndefined();
  const next = advanceCodexPeriods(periods, [quota(start + 180_000, 80)], {
    weekly: { note: "estimated", estimatedPeriodUsd: 120, sampleStartAt: start + 120_000, sampleEndAt: start + 180_000, usedPercent: 20, piAttributedPercent: 20, calibrationPercent: 20, attribution: "verified" },
    fiveHour: { note: "unavailable" },
  });
  expect(next.find((p) => p.kind === "weekly" && !p.closedAt)?.estimatedTotalUsd).toBe(120);
  expect(advanceCodexPeriods(next, [quota(start + 180_000, 80)], estimates(start + 60_000, 80))).toEqual(next);
});

it("persists explicitly labeled conditional quotes without claiming verified Pi consumption", async () => {
  const readings = [quota(start, 90), quota(start + 60_000, 80)];
  const quote: QuotaAmountEstimates["codex"] = {
    fiveHour: { note: "unavailable" },
    weekly: { note: "conditional", attribution: "correlated", calibrationPercent: 10,
      estimatedPeriodUsd: 80, sampleStartAt: start, sampleEndAt: start + 60_000, usedPercent: 10 },
  };
  const periods = advanceCodexPeriods([], readings, quote);
  expect(periods.find((p) => p.kind === "weekly")).toMatchObject({ attribution: "correlated",
    calibrationPercent: 10, estimatedTotalUsd: 80 });
  expect(periods.find((p) => p.kind === "weekly")?.piAttributedPercent).toBeUndefined();
  expect(advanceCodexPeriods(periods, readings, quote)).toEqual(periods);
  const later = advanceCodexPeriods(periods, [...readings, quota(start + 120_000, 70)], quote);
  expect(later.find((p) => p.kind === "weekly")).toMatchObject({ estimatedTotalUsd: 80,
    sampleEndAt: start + 60_000, estimateAsOf: start + 120_000 });
  const root = await mkdtemp(join(tmpdir(), "conditional-periods-")); roots.push(root);
  const store = new CodexPeriodStore("conditional-account", root);
  await store.update([...readings, quota(start + 120_000, 70)], quote);
  expect((await store.load()).find((p) => p.kind === "weekly")).toMatchObject({
    attribution: "correlated", calibrationPercent: 10, estimatedTotalUsd: 80,
  });
});

it("removes legacy quotes that lack independent Pi attribution", () => {
  const legacy = { ...advanceCodexPeriods([], [quota(start, 80)])[0], estimatedTotalUsd: 80, usedPercent: 10 };
  const next = advanceCodexPeriods([legacy], [quota(start + 60_000, 70)]);
  expect(next[0].estimatedTotalUsd).toBeUndefined();
});

it("splits on a moved reset timestamp or plan change without requiring a fixed 5h/7d interval", () => {
  const first = advanceCodexPeriods([], [quota(start, 80)]);
  const moved = advanceCodexPeriods(first, [quota(start + 60_000, 70, 80, resetAt + 3_600_000)]);
  expect(moved.filter((p) => p.kind === "weekly")).toHaveLength(2);
  expect(moved.find((p) => p.kind === "weekly" && p.startedAt === start)?.boundary).toBe("reset-time");
  const changed = advanceCodexPeriods(moved, [{ ...quota(start + 120_000, 60), plan: "plus" }]);
  expect(changed.filter((p) => p.kind === "weekly")).toHaveLength(3);
  expect(changed.find((p) => p.kind === "weekly" && p.startedAt === start + 60_000)?.boundary).toBe("plan-change");
});

it("hides legacy unverified monetary quotes even before another account refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-periods-")); roots.push(root);
  const store = new CodexPeriodStore("old-account", root);
  const { mkdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const folder = join(root, "codex-periods");
  await mkdir(folder);
  const path = join(folder, `${createHash("sha256").update("old-account").digest("hex")}.json`);
  await writeFile(path, JSON.stringify({ version: 1, periods: [{ ...advanceCodexPeriods([], [quota(start, 80)])[0],
    estimatedTotalUsd: 80, usedPercent: 10 }] }));
  expect((await store.load())[0].estimatedTotalUsd).toBeUndefined();
  await store.update([quota(start, 80)], { fiveHour: { note: "unavailable" }, weekly: { note: "unavailable" } });
  expect(await readFile(path, "utf8")).not.toContain("estimatedTotalUsd");
});

it("persists cycle records across restarts, isolates accounts and never stores credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-periods-")); roots.push(root);
  const a = new CodexPeriodStore("account-a", root);
  const b = new CodexPeriodStore("account-b", root);
  await a.update([quota(start, 90), quota(start + 60_000, 80)], estimates(start + 60_000, 80));
  await a.update([quota(start, 90), quota(start + 60_000, 80), quota(start + 120_000, 100)], estimates(start + 60_000, 80));
  const restarted = new CodexPeriodStore("account-a", root);
  expect((await restarted.load()).filter((p) => p.kind === "weekly")).toHaveLength(2);
  expect(await b.load()).toEqual([]);
  const files = await readdir(join(root, "codex-periods"));
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain("account-a");
  const contents = await readFile(join(root, "codex-periods", files[0]), "utf8");
  expect(contents).not.toContain("account-a");
  expect(contents).toContain('"estimatedTotalUsd":80');
  // Damage must not silently replace all historical periods with only recent readings.
  const path = join(root, "codex-periods", files[0]);
  await writeFile(path, "{broken");
  await expect(restarted.update([quota(start + 180_000, 70)], estimates(start + 180_000, 90))).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{broken");
});
