"use strict";

const $ = (id) => document.getElementById(id);
let latest;
let control;
let busy = false;

function money(value) {
  return `$${value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`;
}
function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}
function countdown(resetAt) {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return "重置时间未提供";
  const minutes = Math.max(0, Math.ceil((resetAt - Date.now()) / 60000));
  const remaining = minutes >= 1440 ? `${Math.floor(minutes / 1440)}天 ${Math.floor(minutes % 1440 / 60)}小时`
    : minutes >= 60 ? `${Math.floor(minutes / 60)}小时 ${minutes % 60}分钟` : `${minutes}分钟`;
  return `约 ${remaining}后重置`;
}
function row(parent, label, value) {
  const container = document.createElement("div");
  container.className = "row";
  const left = document.createElement("span");
  left.textContent = label;
  const right = document.createElement("span");
  right.textContent = value;
  container.append(left, right);
  parent.append(container);
}
function notice(parent, value) {
  if (!value) return;
  const el = document.createElement("p");
  el.className = "notice";
  el.textContent = value;
  parent.append(el);
}
function quotaWindow(parent, label, window) {
  const container = document.createElement("div");
  container.className = "quota-window";
  const name = document.createElement("span");
  name.className = "label";
  name.textContent = label;
  const value = document.createElement("strong");
  value.textContent = percent(window?.remainingPercent);
  const reset = document.createElement("small");
  reset.className = "subtle";
  reset.textContent = window ? countdown(window.resetAt) : "未知 / 无数据";
  if (typeof window?.resetAt === "number" && Number.isFinite(window.resetAt)) reset.dataset.resetAt = String(window.resetAt);
  container.append(name, value, reset);
  parent.append(container);
}
function queryLabel(cache, partialError = false) {
  if (cache.error) return "查询失败";
  if (partialError) return "部分查询失败（使用可用数据）";
  if (cache.value) return "查询成功";
  return cache.lastAttemptAt ? "查询中 / 尚无成功结果" : "等待首次查询";
}
function lastSuccess(cache) {
  return cache.value?.capturedAt ? new Date(cache.value.capturedAt).toLocaleString() : "尚无成功查询";
}
function renderProviderErrors(container, cache, extraErrors = []) {
  const messages = [
    ...(cache.error ? [`查询错误：${cache.error}${cache.value ? "；已保留上次成功结果" : "；尚无可保留结果"}`] : []),
    ...extraErrors.filter(Boolean).map((error) => `额度数据提示：${error}`),
  ];
  const fingerprint = JSON.stringify(messages);
  if (container.dataset.messages === fingerprint) return;
  container.dataset.messages = fingerprint;
  container.replaceChildren();
  for (const message of messages) notice(container, message);
}
function statusDetails(container, cache, extraErrors = []) {
  row(container, "查询状态", queryLabel(cache, extraErrors.some(Boolean)));
  row(container, "最近成功时间", lastSuccess(cache));
  if (cache.error) notice(container, `查询错误：${cache.error}${cache.value ? "（保留上次成功结果）" : ""}`);
  for (const error of extraErrors.filter(Boolean)) notice(container, `额度汇总错误：${error}`);
}
function renderCodex(cache) {
  const result = cache.value;
  $("codex-plan").textContent = result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据";
  const windows = $("codex-windows");
  windows.replaceChildren();
  quotaWindow(windows, "5 小时窗口", result?.fiveHour);
  quotaWindow(windows, "每周窗口", result?.weekly);
  $("codex-success").textContent = `最近成功查询：${lastSuccess(cache)}`;
  renderProviderErrors($("codex-error"), cache);
}
function modelGroupName(model) {
  const name = `${model.modelId} ${model.displayName ?? ""}`;
  if (/gemini/i.test(name)) return "Gemini 模型额度（旧版回退）";
  if (/claude|gpt/i.test(name)) return "Claude / GPT 模型额度（旧版回退）";
  return "其他模型额度（旧版回退）";
}
function renderAntigravity(cache) {
  const result = cache.value;
  $("agy-plan").textContent = result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据";
  const container = $("agy-windows");
  container.replaceChildren();
  const groups = result?.groups ?? [];
  const models = result?.models ?? [];
  if (groups.length) {
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "quota-group";
      const heading = document.createElement("h4");
      heading.textContent = group.name;
      section.append(heading);
      const items = document.createElement("div");
      items.className = "quota-windows";
      if (group.windows?.length) {
        for (const window of group.windows) quotaWindow(items, window.label, window);
      } else {
        const candidates = models.filter((model) => new RegExp(group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${model.modelId} ${model.displayName ?? ""}`));
        if (candidates.length) {
          for (const model of candidates) quotaWindow(items, `${model.displayName ?? model.modelId} · 模型额度`, model);
        } else {
          quotaWindow(items, "额度窗口", undefined);
        }
      }
      section.append(items);
      container.append(section);
    }
  } else if (models.length) {
    const grouped = new Map();
    for (const model of models) {
      const name = modelGroupName(model);
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(model);
    }
    for (const [name, groupModels] of grouped) {
      const section = document.createElement("section");
      section.className = "quota-group";
      const heading = document.createElement("h4");
      heading.textContent = name;
      const items = document.createElement("div");
      items.className = "quota-windows";
      for (const model of groupModels) quotaWindow(items, model.displayName ?? model.modelId, model);
      section.append(heading, items);
      container.append(section);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = result ? "暂无额度窗口或模型额度数据。" : "尚无成功查询结果；额度数据未知。";
    container.append(empty);
  }
  $("agy-success").textContent = `最近成功查询：${lastSuccess(cache)}`;
  renderProviderErrors($("agy-error"), cache, [result?.summaryError]);
}
function renderCountdown() {
  for (const reset of document.querySelectorAll("[data-reset-at]")) {
    reset.textContent = countdown(Number(reset.dataset.resetAt));
  }
}
const SVG_NS = "http://www.w3.org/2000/svg";
function svgElement(name, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
function calendarDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function renderChart() {
  if (!latest) return;
  const period = $("chart-period").value;
  const model = $("chart-model").value;
  const selected = model === "all" ? null : JSON.parse(model);
  const current = new Date(`${latest.usage.timeline.today}T12:00:00`);
  const slots = period === "days" ? Array.from({ length: 30 }, (_, index) => {
    const date = new Date(current);
    date.setDate(date.getDate() - (29 - index));
    return { bucket: calendarDay(date), label: date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) };
  }) : Array.from({ length: 24 }, (_, index) => {
    const hour = latest.usage.timeline.currentHour - (23 - index) * 3600000;
    return { bucket: String(hour), label: new Date(hour).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) };
  });
  const counts = new Map(slots.map(({ bucket }) => [bucket, 0]));
  for (const item of period === "days" ? latest.usage.timeline.days : latest.usage.timeline.hours) {
    if (counts.has(item.bucket) && (!selected || (item.provider === selected[0] && item.model === selected[1]))) {
      counts.set(item.bucket, counts.get(item.bucket) + item.totalTokens);
    }
  }
  const values = slots.map(({ bucket }) => counts.get(bucket));
  const peak = Math.max(0, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const label = selected ? `${selected[0]} / ${selected[1]}` : "全部模型";
  $("chart-summary").textContent = `${period === "days" ? "最近 30 天" : "最近 24 小时"} · ${label} · ${total.toLocaleString()} tokens${latest.usage.stale ? "（账本汇总已过期）" : ""}`;
  const chart = $("chart");
  chart.setAttribute("aria-label", `${label}在${period === "days" ? "最近30天" : "最近24小时"}消耗 ${total.toLocaleString()} tokens 的时间趋势`);
  chart.replaceChildren();
  const svg = svgElement("svg", { viewBox: "0 0 1000 290", role: "presentation", "aria-hidden": "true" });
  const left = 76, right = 972, top = 20, bottom = 245;
  for (let tick = 0; tick <= 2; tick++) {
    const y = bottom - tick * (bottom - top) / 2;
    svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 13, y: y + 5, class: "axis-label", "text-anchor": "end" }, Math.round(peak * tick / 2).toLocaleString()));
  }
  const points = values.map((value, index) => {
    const x = left + index * (right - left) / (values.length - 1);
    const y = bottom - (peak ? value / peak : 0) * (bottom - top);
    return { x, y, value };
  });
  const line = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
  svg.append(svgElement("path", { d: `${line} L${right} ${bottom} L${left} ${bottom} Z`, class: "chart-area" }));
  svg.append(svgElement("path", { d: line, class: "chart-line" }));
  for (let index = 0; index < slots.length; index++) {
    const { x, y, value } = points[index];
    const circle = svgElement("circle", { cx: x, cy: y, r: 3.5, class: "chart-point" });
    circle.append(svgElement("title", {}, `${slots[index].label}: ${value.toLocaleString()} tokens`));
    svg.append(circle);
    if (index === 0 || index === slots.length - 1 || index % (period === "days" ? 7 : 6) === 0) {
      svg.append(svgElement("text", { x, y: 279, class: "axis-label", "text-anchor": index === 0 ? "start" : index === slots.length - 1 ? "end" : "middle" }, slots[index].label));
    }
  }
  chart.append(svg);
  if (!total) notice(chart, "所选时间与模型暂无 Token 记录。");
}
function renderPriceTable(pricing) {
  $("price-date").textContent = pricing.asOf;
  const container = $("price-table");
  if (container.dataset.version === pricing.asOf) return;
  container.dataset.version = pricing.asOf;
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of ["Provider", "模型 / 官方来源", "Input", "Cache read", "Cache write", "Output", "高上下文阈值"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = document.createElement("tbody");
  for (const item of pricing.catalog) {
    const tr = document.createElement("tr");
    const provider = document.createElement("td");
    provider.textContent = item.provider;
    const model = document.createElement("td");
    const link = document.createElement("a");
    link.href = item.source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.model;
    model.append(link);
    tr.append(provider, model);
    for (const value of [item.rates.input, item.rates.cacheRead, item.rates.cacheWrite, item.rates.output,
      item.longContext ? `> ${Number(item.longContext.threshold).toLocaleString()} tokens` : "—"]) {
      const td = document.createElement("td");
      td.textContent = value === undefined ? "—" : String(value);
      tr.append(td);
    }
    body.append(tr);
    if (item.longContext) {
      const elevated = document.createElement("tr");
      for (const text of [item.provider, `${item.model} · 高上下文`, item.longContext.rates.input,
        item.longContext.rates.cacheRead, item.longContext.rates.cacheWrite ?? "—",
        item.longContext.rates.output, `> ${Number(item.longContext.threshold).toLocaleString()} tokens`]) {
        const td = document.createElement("td");
        td.textContent = String(text);
        elevated.append(td);
      }
      body.append(elevated);
    }
  }
  table.append(body);
  container.replaceChildren(table);
}
function render() {
  if (!latest) return;
  const codex = latest.codex;
  const agy = latest.antigravity;
  renderCodex(codex);
  renderAntigravity(agy);
  const codexStatus = $("codex-query-status");
  codexStatus.replaceChildren();
  statusDetails(codexStatus, codex);
  const agyStatus = $("agy-query-status");
  agyStatus.replaceChildren();
  statusDetails(agyStatus, agy, [agy.value?.summaryError]);
  const usage = latest.usage;
  $("overview-tokens").textContent = Number(usage.totals.totalTokens).toLocaleString();
  $("overview-tokens-detail").textContent = !usage.records ? "暂无本插件记录的用量"
    : `${usage.records.toLocaleString()} 条账本记录${usage.stale ? " · 汇总已过期" : ""}${usage.invalidRecords ? ` · ${usage.invalidRecords.toLocaleString()} 条损坏记录已跳过` : ""}`;
  const pricing = usage.pricing;
  $("overview-cost").textContent = pricing.pricedRecords ? money(pricing.estimatedCostUsd) : "—";
  $("overview-cost-detail").textContent = `${pricing.unpricedRecords
    ? `${pricing.pricedRecords ? "部分估算" : "暂无可估算费用"} · ${pricing.unpricedRecords.toLocaleString()} 条未计价（${pricing.unpricedTokens.toLocaleString()} tokens）`
    : pricing.pricedRecords ? `${pricing.pricedRecords.toLocaleString()} 条已计价 · API 标价` : "暂无可计价记录"}${usage.stale ? " · 账本汇总已过期" : ""}`;
  const context = latest.context;
  $("overview-context").textContent = typeof context?.percent === "number" ? `${Math.round(context.percent)}%` : "—";
  $("overview-context-detail").textContent = context ? `${context.tokens === null ? "未知" : Number(context.tokens).toLocaleString()} / ${Number(context.contextWindow).toLocaleString()} tokens` : "当前模型未提供上下文窗口";
  const columns = [["Input", "input"], ["Output", "output"], ["Reasoning", "reasoning"], ["Cache read", "cacheRead"], ["Cache write", "cacheWrite"], ["Total tokens", "totalTokens"]];
  const tokens = $("tokens");
  tokens.replaceChildren();
  if (usage.stale) notice(tokens, usage.error || "Token 汇总已过期，显示上次有效结果");
  if (usage.invalidRecords) notice(tokens, `已跳过 ${usage.invalidRecords.toLocaleString()} 条损坏记录。`);
  if (pricing.unpricedRecords) notice(tokens, `${pricing.unpricedRecords.toLocaleString()} 条用量没有可靠价格，估算费用未覆盖这些记录。`);
  if (!usage.records) notice(tokens, "暂无本插件记录的 Token 用量。");
  const total = document.createElement("div");
  total.className = "token-total";
  total.textContent = Number(usage.totals.totalTokens).toLocaleString();
  tokens.append(total);
  const metrics = document.createElement("div");
  metrics.className = "metrics";
  for (const [label, key] of columns) {
    const metric = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("strong");
    value.textContent = Number(usage.totals[key]).toLocaleString();
    metric.append(name, value);
    metrics.append(metric);
  }
  tokens.append(metrics);
  const modelSelect = $("chart-model");
  const choices = [["全部模型", "all"], ...usage.models.map((item) => [`${item.provider} / ${item.model}`, JSON.stringify([item.provider, item.model])])];
  if (modelSelect.options.length !== choices.length || choices.some(([, value], index) => modelSelect.options[index]?.value !== value)) {
    const selectedModel = modelSelect.value;
    modelSelect.replaceChildren(...choices.map(([label, value]) => new Option(label, value)));
    modelSelect.value = choices.some(([, value]) => value === selectedModel) ? selectedModel : "all";
  }
  renderChart();
  const models = $("models");
  models.replaceChildren();
  if (usage.models.length) {
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = "按 Provider 和模型分组，Total tokens 降序";
    table.append(caption);
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Provider", "Model", ...columns.map(([name]) => name), "估算费用 USD"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.append(cell);
    }
    head.append(header);
    table.append(head);
    const body = document.createElement("tbody");
    for (const item of usage.models) {
      const tr = document.createElement("tr");
      for (const text of [item.provider, item.model, ...columns.map(([, key]) => Number(item[key]).toLocaleString()),
        item.pricedRecords ? `${money(item.estimatedCostUsd)}${item.unpricedRecords ? " + 未计价" : ""}` : "未计价"]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        tr.append(cell);
      }
      body.append(tr);
    }
    table.append(body);
    models.append(table);
  } else {
    models.textContent = "暂无模型明细";
  }
  renderPriceTable(pricing);
  if (document.activeElement !== $("interval")) $("interval").value = String(latest.config.refreshIntervalSeconds);
  if (!busy) {
    $("show-oai").checked = latest.config.showOaiInStatusbar;
    $("show-agy").checked = latest.config.showAgyInStatusbar;
  }
  $("last-check").textContent = `账本更新：${usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString() : "尚未成功读取"} · 页面读取：${new Date(latest.updatedAt).toLocaleTimeString()}`;
}
async function load() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("本地会话已结束，请在 Pi 中重新运行 /quota console");
  const state = await response.json();
  control = state.control;
  latest = state;
  render();
  $("feedback").textContent = "";
}
function syncStatusbarControls() {
  if (!latest) return;
  $("show-oai").checked = latest.config.showOaiInStatusbar;
  $("show-agy").checked = latest.config.showAgyInStatusbar;
}
function setBusy(value) {
  busy = value;
  for (const id of ["refresh", "interval", "interval-submit", "show-oai", "show-agy"]) $(id).disabled = value;
}
async function action(path, body) {
  if (busy || !control) return;
  setBusy(true);
  $("feedback").textContent = "处理中…";
  try {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Quota-Control": control },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "操作失败");
    await load();
    $("feedback").textContent = "已更新";
  } catch (error) {
    syncStatusbarControls();
    $("feedback").textContent = error.message || "操作失败";
  } finally {
    setBusy(false);
  }
}
$("refresh").addEventListener("click", () => { void action("/api/refresh"); });
$("chart-period").addEventListener("change", renderChart);
$("chart-model").addEventListener("change", renderChart);
$("interval-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Number($("interval").value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) return;
  void action("/api/interval", { seconds });
});
$("show-oai").addEventListener("change", (event) => {
  void action("/api/statusbar", { showOaiInStatusbar: event.currentTarget.checked });
});
$("show-agy").addEventListener("change", (event) => {
  void action("/api/statusbar", { showAgyInStatusbar: event.currentTarget.checked });
});
void load().catch((error) => { $("feedback").textContent = error.message; });
setInterval(() => { void load().catch((error) => { $("feedback").textContent = error.message; }); }, 5000);
setInterval(renderCountdown, 1000);
