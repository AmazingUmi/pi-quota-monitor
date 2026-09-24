import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { dashboardFixture } from "./fixtures/dashboard-state.js";

const html = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/dashboard/client.js", import.meta.url), "utf8");
const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

async function mount(state = dashboardFixture()) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3000", runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { ok: true } : state)));
  dom.window.fetch = fetch;
  // The production poll is tested explicitly, without leaving real timers running.
  dom.window.setInterval = vi.fn(() => 1);
  new Script(script).runInContext(dom.getInternalVMContext());
  await vi.waitFor(() => expect(dom.window.document.getElementById("connection-status")?.dataset.state).toBe("connected"));
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  return { dom, get, state, fetch, reload: () => dom.window.eval("load()") as Promise<void> };
}

it("renders quota meters, compact totals, and distinct low-quota states", async () => {
  const { get, dom } = await mount();
  expect(get("overview-tokens").textContent).toBe("2,480,000");
  expect(get("overview-cost").textContent).toBe("$12.60");
  expect(get<HTMLMeterElement>("context-meter").value).toBe(26);
  const codex = get("codex-windows").querySelectorAll("meter");
  expect([...codex].map((meter) => meter.value)).toEqual([61, 73]);
  expect(codex[0].getAttribute("aria-label")).toBe("Weekly Limit Remaining剩余百分比");
  expect([...get("agy-windows").querySelectorAll("meter")].map((meter) => meter.dataset.level)).toEqual(["normal", "normal", "low", "warning"]);
  expect(get("tokens").querySelectorAll(".metrics > div")).toHaveLength(6);
  expect(dom.window.document.querySelector(".token-total")).toBeNull();
  expect(get("chart").querySelector("svg")).not.toBeNull();
  expect(get("cost-chart").getAttribute("aria-label")).toContain("估算金额");
});

it("preserves open amount details and focus across unchanged and changed cache polls", async () => {
  const { get, dom, state, reload } = await mount();
  const details = get("codex-windows").querySelector("details")!;
  details.open = true;
  details.querySelector("summary")!.focus();
  await reload();
  expect(get("codex-windows").querySelector("details")).toBe(details);
  state.codex.value!.weekly!.remainingPercent = 72;
  await reload();
  const updated = get("codex-windows").querySelector("details")!;
  expect(updated.open).toBe(true);
  expect(dom.window.document.activeElement).toBe(updated.querySelector("summary"));
  expect(get("codex-windows").querySelector("meter")?.value).toBe(72);
});

it("keeps additional model groups compact without hiding their quota summary", async () => {
  const { get, state, reload } = await mount();
  const group = get("agy-windows").querySelector<HTMLDetailsElement>(".quota-group-more")!;
  expect(group.open).toBe(false);
  expect(group.querySelector("summary")?.textContent).toContain("8% / 20% 剩余");
  group.open = true;
  const amount = group.querySelector("details")!;
  amount.open = true;
  state.antigravity.value!.capturedAt += 1000;
  await reload();
  const updated = get("agy-windows").querySelector<HTMLDetailsElement>(".quota-group-more")!;
  expect(updated.open).toBe(true);
  expect(updated.querySelector("details")!.open).toBe(true);
});

it("does not reuse active Codex quota or money in other ledger views", async () => {
  const { get, state, reload } = await mount();
  state.selectedAccountId = "all";
  await reload();
  expect(get("codex-plan").textContent).toContain("无法查询");
  expect([...get("codex-windows").querySelectorAll("meter")].every((meter) => meter.hidden)).toBe(true);
  expect(get("codex-windows").querySelector("details")).toBeNull();
  expect(get("agy-windows").querySelector("meter")?.value).toBe(83);
});

it("distinguishes unknown, not-applicable, and zero quota, and keeps estimate warnings visible", async () => {
  const state = dashboardFixture();
  state.codex.value!.plan = "pro";
  delete state.codex.value!.fiveHour;
  state.codex.value!.weekly!.remainingPercent = 0;
  state.context = null;
  state.quotaEstimates.codex.weekly.unpricedRecords = 3;
  state.quotaEstimates.codex.weekly.ledgerStale = true;
  const { get } = await mount(state);
  const meters = get("codex-windows").querySelectorAll("meter");
  expect(meters[1].hidden).toBe(true);
  expect(meters[0].hidden).toBe(false);
  expect(meters[0].value).toBe(0);
  expect(meters[0].dataset.level).toBe("low");
  expect(get("codex-windows").textContent).toContain("Pro 暂无 5 小时限制");
  expect(get("codex-windows").querySelector(".quota-estimate-note")?.textContent).toContain("3 条未计价");
  expect(get("codex-windows").querySelector(".quota-estimate-note")?.textContent).toContain("账本汇总已过期");
  expect(get("context-meter").hidden).toBe(true);
  expect(get("overview-context").textContent).toBe("—");
});

it("retains time/model filters and accessible empty/unpriced states", async () => {
  const { get, dom, state, reload } = await mount();
  get<HTMLSelectElement>("chart-period").value = "days";
  get("chart-period").dispatchEvent(new dom.window.Event("change"));
  expect(get("chart").getAttribute("aria-label")).toContain("最近30天");
  get<HTMLSelectElement>("chart-model").value = JSON.stringify(["antigravity", "gemini-3.1-pro"]);
  get("chart-model").dispatchEvent(new dom.window.Event("change"));
  expect(get("chart").querySelector(".empty-state")?.textContent).toContain("暂无 Token 记录");
  await reload();
  expect(get<HTMLSelectElement>("chart-model").value).toBe(JSON.stringify(["antigravity", "gemini-3.1-pro"]));
  state.usage.timeline.days.push({ bucket: state.usage.timeline.today, provider: "antigravity", model: "gemini-3.1-pro", totalTokens: 100, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1 });
  await reload();
  expect(get("cost-chart").querySelector(".notice")?.textContent).toContain("未计价记录");
  expect(get("cost-chart").querySelector(".empty-state")).toBeNull();
});

it("keeps refresh/settings actions authenticated and restores controls after failure", async () => {
  const { get, dom, fetch } = await mount();
  get("refresh").click();
  await vi.waitFor(() => expect(get("feedback").textContent).toBe("已更新"));
  expect(fetch).toHaveBeenCalledWith("/api/refresh", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Quota-Control": "test-control" }) }));
  expect(get<HTMLButtonElement>("refresh").disabled).toBe(false);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "保存失败" }), { status: 500 }));
  get<HTMLInputElement>("show-oai").checked = false;
  get("show-oai").dispatchEvent(new dom.window.Event("change"));
  await vi.waitFor(() => expect(get("feedback").textContent).toBe("保存失败"));
  expect(get<HTMLInputElement>("show-oai").checked).toBe(true);
  expect(get<HTMLInputElement>("show-oai").disabled).toBe(false);
});

it("reports a disconnected session and recovers on the next successful read", async () => {
  const { get, dom, fetch, reload } = await mount();
  fetch.mockRejectedValueOnce(new Error("本地会话已结束"));
  await dom.window.eval("load().catch(loadError)");
  expect(get("connection-status").dataset.state).toBe("offline");
  expect(get("feedback").textContent).toBe("本地会话已结束");
  await reload();
  expect(get("connection-status").dataset.state).toBe("connected");
  expect(get("feedback").textContent).toBe("");
});

it("shows help on hover/focus and supports click, outside dismissal, and Escape", async () => {
  const { dom, get } = await mount();
  for (const id of ["data-help", "quota-help"]) {
    const content = get(id);
    const tip = content.parentElement!;
    const button = tip.querySelector("button")!;
    expect(content.hidden).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(id);
    tip.dispatchEvent(new dom.window.Event("pointerenter"));
    expect(content.hidden).toBe(false);
    tip.dispatchEvent(new dom.window.Event("pointerleave"));
    expect(content.hidden).toBe(true);
    button.focus();
    expect(content.hidden).toBe(false);
    button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(content.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    expect(content.hidden).toBe(false);
    dom.window.document.body.click();
    expect(content.hidden).toBe(true);
  }
});

it("retains an unsaved port draft across polling and surfaces occupancy without saving", async () => {
  const { dom, get, fetch, reload, state } = await mount();
  const input = get<HTMLInputElement>("dashboard-port");
  input.value = "40001";
  input.dispatchEvent(new dom.window.Event("input"));
  await reload();
  expect(input.value).toBe("40001");
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ available: false, message: "端口 40001 已被占用" })));
  get("port-check").click();
  await vi.waitFor(() => expect(get("port-feedback").textContent).toContain("已被占用"));
  expect(get("port-feedback").dataset.error).toBe("true");
  expect(fetch).toHaveBeenLastCalledWith("/api/port-check", expect.objectContaining({ body: JSON.stringify({ port: 40001 }), headers: expect.objectContaining({ "X-Quota-Control": "test-control" }) }));
  expect(state.config.dashboardPort).toBe(38457);
  expect(input.disabled).toBe(false);
});

it("saves ports for next startup without navigating, and preserves settings on failure", async () => {
  const { dom, get, fetch } = await mount();
  const input = get<HTMLInputElement>("dashboard-port");
  input.value = "40002";
  input.dispatchEvent(new dom.window.Event("input"));
  get("port-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(get("port-feedback").textContent).toContain("已保存端口 40002"));
  expect(get("port-state").textContent).toContain("已保存端口：40002（下次启动控制台生效）");
  expect(dom.window.location.href).toBe("http://127.0.0.1:3000/");
  expect(fetch).toHaveBeenLastCalledWith("/api/port", expect.objectContaining({ body: JSON.stringify({ port: 40002 }) }));
  input.value = "40003";
  input.dispatchEvent(new dom.window.Event("input"));
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "端口 40003 已被占用" }), { status: 409 }));
  get("port-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(get("port-feedback").textContent).toContain("已被占用"));
  expect(get("port-state").textContent).toContain("已保存端口：40002");
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("40003");
  const calls = fetch.mock.calls.length;
  input.value = "0";
  get("port-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  expect(fetch.mock.calls.length).toBe(calls);
});

it("normalizes and orders OAI/AGY windows without detaching their estimates or inventing durations", async () => {
  const state = dashboardFixture();
  state.antigravity.value!.groups[0].windows = [
    { label: "5H Limit Remaining", remainingPercent: 25 },
    { label: "Daily limit", remainingPercent: 50, windowMinutes: 1440 },
    { label: "Weekly Limit Remaining", remainingPercent: 75 },
  ];
  state.quotaEstimates.antigravity.groups[0].windows = [
    { note: "5h estimate", observedCostUsd: 1, estimatedPeriodUsd: 10, estimatedRemainingUsd: 2.5 },
    { note: "Daily not estimated" },
    { note: "weekly estimate", observedCostUsd: 2, estimatedPeriodUsd: 20, estimatedRemainingUsd: 15 },
  ];
  const { get, reload } = await mount(state);
  const labels = (id: string) => [...get(id).querySelectorAll(".quota-window .label")].map((el) => el.textContent);
  expect(labels("codex-windows")).toEqual(["Weekly Limit Remaining", "5H Limit Remaining"]);
  expect(labels("agy-windows").slice(0, 3)).toEqual(["Weekly Limit Remaining", "5H Limit Remaining", "Daily limit"]);
  const windows = get("agy-windows").querySelectorAll(".quota-window");
  expect(windows[0].querySelector("meter")?.value).toBe(75);
  expect(windows[0].querySelector("summary")?.textContent).toContain("$15.00");
  expect(windows[1].querySelector("summary")?.textContent).toContain("$2.50");
  expect(state.antigravity.value!.groups[0].windows[0].label).toBe("5H Limit Remaining");
  await reload();
  expect(labels("agy-windows").slice(0, 2)).toEqual(labels("codex-windows"));
});

it("switches quota graphics without losing open details and distinguishes zero/full/unknown pies", async () => {
  const state = dashboardFixture();
  state.codex.value!.weekly!.remainingPercent = 0;
  state.codex.value!.fiveHour!.remainingPercent = 100;
  const { dom, get, reload } = await mount(state);
  const detail = get("codex-windows").querySelector("details")!;
  detail.open = true;
  get<HTMLSelectElement>("quota-view").value = "pie";
  get("quota-view").dispatchEvent(new dom.window.Event("change"));
  expect(get("provider-grid").dataset.quotaView).toBe("pie");
  expect(get("quota-pie-legend").hidden).toBe(false);
  let pies = get("codex-windows").querySelectorAll(".quota-pie");
  expect(pies[0].getAttribute("aria-label")).toContain("剩余 0%，已用 100%");
  expect(pies[0].querySelector(".pie-remaining")).toBeNull();
  expect(pies[1].querySelector("circle.pie-remaining")).not.toBeNull();
  await reload();
  expect(get("provider-grid").dataset.quotaView).toBe("pie");
  expect(detail.open).toBe(true);
  delete state.codex.value!.weekly;
  delete state.codex.value!.fiveHour;
  state.codex.value!.plan = "pro";
  await reload();
  pies = get("codex-windows").querySelectorAll(".quota-pie");
  expect(pies[0].querySelector(".pie-unknown")).not.toBeNull();
  expect(pies[0].getAttribute("aria-label")).toContain("暂无数据");
  expect(pies[1].getAttribute("aria-label")).toContain("不适用");
  expect(get("codex-windows").querySelector(".pie-remaining")).toBeNull();
  get<HTMLSelectElement>("quota-view").value = "bar";
  get("quota-view").dispatchEvent(new dom.window.Event("change"));
  expect(get("provider-grid").dataset.quotaView).toBe("bar");
  expect(get("quota-pie-legend").hidden).toBe(true);
});

it.each(["hours", "days"] as const)("computes %s cumulative series from the selected range/model without summing cumulative points twice", async (period) => {
  const state = dashboardFixture();
  const { today, currentHour } = state.usage.timeline;
  const previousDay = new Date(`${today}T12:00:00`);
  previousDay.setDate(previousDay.getDate() - 2);
  const first = period === "hours" ? String(currentHour - 2 * 3600000)
    : `${previousDay.getFullYear()}-${String(previousDay.getMonth() + 1).padStart(2, "0")}-${String(previousDay.getDate()).padStart(2, "0")}`;
  const last = period === "hours" ? String(currentHour) : today;
  const item = { provider: "openai-codex", model: "gpt-6-sol", pricedRecords: 1, unpricedRecords: 0 };
  state.usage.timeline[period] = [
    { ...item, bucket: first, totalTokens: 10, estimatedCostUsd: 1 },
    { ...item, bucket: last, totalTokens: 20, estimatedCostUsd: 2 },
    { ...item, bucket: last, totalTokens: 5, estimatedCostUsd: .5 },
    { ...item, bucket: "out-of-range", totalTokens: 999, estimatedCostUsd: 999 },
    { ...item, bucket: last, provider: "antigravity", model: "gemini-3.1-pro", totalTokens: 7, estimatedCostUsd: .7 },
  ];
  const { dom, get, reload } = await mount(state);
  get<HTMLSelectElement>("chart-period").value = period;
  get<HTMLSelectElement>("chart-model").value = JSON.stringify(["openai-codex", "gpt-6-sol"]);
  get<HTMLSelectElement>("chart-view").value = "cumulative";
  get("chart-view").dispatchEvent(new dom.window.Event("change"));
  const values = (id: string) => [...get(id).querySelectorAll("circle title")].map((title) => Number(title.textContent!.split(": ").at(-1)!.replace(/[$,]| tokens|（USD，估算）/g, "")));
  expect(values("chart").slice(-3)).toEqual([10, 10, 35]);
  expect(values("cost-chart").slice(-3)).toEqual([1, 1, 3.5]);
  expect(get("chart-summary").textContent).toContain("35 tokens");
  expect(get("cost-chart-summary").textContent).toContain("$3.50");
  expect(get("chart").getAttribute("aria-label")).toContain("时段累计");
  expect(get("chart-view-note").textContent).toContain("非全部历史用量");
  await reload();
  expect(get("chart").dataset.view).toBe("cumulative");
  expect(values("chart").at(-1)).toBe(35);
  get<HTMLSelectElement>("chart-model").value = "all";
  get("chart-model").dispatchEvent(new dom.window.Event("change"));
  expect(values("chart").at(-1)).toBe(42);
  get<HTMLSelectElement>("chart-view").value = "interval";
  get("chart-view").dispatchEvent(new dom.window.Event("change"));
  expect(values("chart").slice(-3)).toEqual([10, 0, 32]);
  expect(get("chart-summary").textContent).toContain("42 tokens");
});

it("retains unpriced and empty warnings in cumulative mode", async () => {
  const state = dashboardFixture();
  state.usage.timeline.hours = [{ bucket: String(state.usage.timeline.currentHour), provider: "openai-codex", model: "gpt-6-sol", totalTokens: 100, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 1 }];
  const { dom, get, reload } = await mount(state);
  get<HTMLSelectElement>("chart-view").value = "cumulative";
  get("chart-view").dispatchEvent(new dom.window.Event("change"));
  expect(get("cost-chart-summary").textContent).toContain("1 条未计价未纳入金额");
  expect(get("cost-chart").querySelector(".notice")?.textContent).toContain("未计价记录");
  expect(get("chart-summary").textContent).toContain("100 tokens");
  state.usage.timeline.hours = [];
  await reload();
  expect(get("chart").querySelector(".empty-state")).not.toBeNull();
});

it("explains a fallback port and only changes the saved preference after explicit saving", async () => {
  const state = { ...dashboardFixture(), dashboard: { port: 40001, fallbackFrom: 38457 } };
  const { get, fetch } = await mount(state);
  expect(get("port-fallback").hidden).toBe(false);
  expect(get("port-fallback-message").textContent).toContain("已自动改用 40001");
  get("settings").scrollIntoView = vi.fn();
  get("port-open-settings").click();
  expect(get<HTMLDetailsElement>("settings").open).toBe(true);
  get("port-use-current").click();
  expect(get<HTMLInputElement>("dashboard-port").value).toBe("40001");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(get("port-state").textContent).toContain("已保存端口：38457");
  get("port-submit").click();
  await vi.waitFor(() => expect(get("port-feedback").textContent).toContain("已保存端口 40001"));
  expect(get("port-fallback").hidden).toBe(true);
});

it("labels restored readings, persistence failures, and the exact calibration sample", async () => {
  const state = dashboardFixture();
  state.codex.restored = true;
  state.codex.storageError = "读数保存失败；当前显示内存读数。";
  const { get, reload } = await mount(state);
  expect(get("codex-error").textContent).toContain("已加载上次保存的读数");
  expect(get("codex-query-status").textContent).toContain("等待刷新");
  expect(get("codex-error").textContent).toContain("读数保存失败");
  const amount = get("codex-windows").querySelector(".quota-money p")!.textContent;
  expect(amount).toContain("500,000 tokens");
  expect(amount).toContain("额度下降 27 个百分点");
  expect(amount).toContain("→");
  expect(amount).not.toContain("已用金额");
  state.codex.restored = false;
  delete state.codex.storageError;
  await reload();
  expect(get("codex-error").textContent).not.toContain("上次保存");
  expect(get("codex-query-status").textContent).toContain("查询成功");
});

it("has unique IDs and working navigation/disclosure targets", async () => {
  const { dom } = await mount();
  const document = dom.window.document;
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
  }
  for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) {
    expect(document.getElementById(label.htmlFor)).not.toBeNull();
  }
  for (const close of document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]")) {
    expect(document.getElementById(close.dataset.closeDialog!)?.tagName).toBe("DIALOG");
  }
});
