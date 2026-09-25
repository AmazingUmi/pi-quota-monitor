"use strict";

const $ = (id) => document.getElementById(id);
let latest;
let control;
let busy = false;
let selectedAccount;
let lastAccountNoticeAt = 0;
let portDirty = false;

function money(value) {
  return `$${value > 0 && value < 0.0001 ? value.toPrecision(2) : value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`;
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
function notice(parent, value, neutral = false) {
  if (!value) return;
  const el = document.createElement("p");
  el.className = neutral ? "notice empty-state" : "notice";
  el.textContent = value;
  parent.append(el);
}
function windowKind(window) {
  if (typeof window.windowMinutes === "number") return window.windowMinutes === 10080 ? "weekly" : window.windowMinutes === 300 ? "fiveHour" : "other";
  if (/\bweek(?:ly)?\b|每周|周额度|周窗口/i.test(window.label)) return "weekly";
  if (/\b5\s*[- ]?(?:h|hours?)\b|\bfive\s*[- ]?hours?\b|5\s*小时/i.test(window.label)) return "fiveHour";
  return "other";
}
const WINDOW_LABELS = { weekly: "Weekly Limit Remaining", fiveHour: "5H Limit Remaining" };
function orderedWindows(windows, estimates) {
  const rank = { weekly: 0, fiveHour: 1, other: 2 };
  // Pair estimates before sorting so weekly and 5H dollar values never get swapped.
  return windows.map((window, index) => ({ window, estimate: estimates?.[index], kind: windowKind(window) }))
    .sort((a, b) => rank[a.kind] - rank[b.kind]);
}
function quotaPie(label, remaining, notApplicable) {
  const known = typeof remaining === "number" && Number.isFinite(remaining);
  const amount = known ? Math.max(0, Math.min(100, remaining)) : 0;
  const description = known ? `剩余 ${percent(amount)}，已用 ${percent(100 - amount)}` : notApplicable ? "不适用" : "暂无数据";
  const svg = svgElement("svg", { class: "quota-pie", viewBox: "0 0 120 120", role: "img", "aria-label": `${label}：${description}` });
  svg.dataset.level = amount <= 10 ? "low" : amount <= 25 ? "warning" : "normal";
  svg.append(svgElement("title", {}, `${label}：${description}`));
  svg.append(svgElement("circle", { cx: 60, cy: 60, r: 50, class: known ? "pie-used" : "pie-unknown" }));
  if (known && amount === 100) {
    svg.append(svgElement("circle", { cx: 60, cy: 60, r: 50, class: "pie-remaining" }));
  } else if (known && amount > 0) {
    const angle = amount / 100 * 2 * Math.PI;
    const x = 60 + 50 * Math.sin(angle), y = 60 - 50 * Math.cos(angle);
    svg.append(svgElement("path", { d: `M60 60 L60 10 A50 50 0 ${amount > 50 ? 1 : 0} 1 ${x} ${y} Z`, class: "pie-remaining" }));
  } else if (!known) {
    svg.append(svgElement("text", { x: 60, y: 65, "text-anchor": "middle", class: "pie-empty-label" }, notApplicable ? "N/A" : "—"));
  }
  return svg;
}
function quotaWindow(parent, label, window, estimate, notApplicable = false, showTotal = false) {
  const container = document.createElement("div");
  container.className = "quota-window";
  const name = document.createElement("span");
  name.className = "label";
  name.textContent = label;
  const value = document.createElement("strong");
  const remaining = window?.remainingPercent;
  const known = typeof remaining === "number" && Number.isFinite(remaining);
  value.textContent = percent(remaining);
  const valueRow = document.createElement("div");
  valueRow.className = "quota-value";
  const unit = document.createElement("span");
  unit.className = "quota-unit";
  unit.textContent = known ? "剩余" : notApplicable ? "不适用" : "暂无数据";
  valueRow.append(value, unit);
  const meter = document.createElement("meter");
  meter.className = "quota-meter";
  meter.min = 0;
  meter.max = 100;
  meter.value = known ? Math.max(0, Math.min(100, remaining)) : 0;
  meter.hidden = !known;
  meter.dataset.level = remaining <= 10 ? "low" : remaining <= 25 ? "warning" : "normal";
  meter.setAttribute("aria-label", `${label}剩余百分比`);
  const reset = document.createElement("small");
  reset.className = "subtle";
  reset.textContent = notApplicable ? "Pro 暂无 5 小时限制" : window ? countdown(window.resetAt) : "未知 / 无数据";
  if (typeof window?.resetAt === "number" && Number.isFinite(window.resetAt)) reset.dataset.resetAt = String(window.resetAt);
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  bar.dataset.known = String(known);
  bar.append(meter);
  container.append(name, valueRow, bar, quotaPie(label, remaining, notApplicable), reset);
  const estimated = Number.isFinite(estimate?.estimatedPeriodUsd) && Number.isFinite(estimate?.estimatedRemainingUsd);
  if (showTotal && !notApplicable) {
    const amounts = document.createElement("div");
    amounts.className = "quota-money-values";
    for (const [name, value] of [[estimate?.attribution === "correlated" ? "剩余条件估算" : "剩余估算", estimate?.estimatedRemainingUsd],
      [estimate?.attribution === "correlated" ? "当期总金额条件估算" : "当期总金额估算", estimate?.estimatedPeriodUsd]]) {
      const item = document.createElement("div");
      const caption = document.createElement("span");
      caption.textContent = name;
      const figure = document.createElement("strong");
      figure.textContent = estimated ? money(value) : "—";
      item.append(caption, figure);
      amounts.append(item);
    }
    container.append(amounts);
    if (!estimated) notice(container, estimate?.note ?? "等待额度读数，暂不可估算金额。", true);
  }
  if (estimate && !notApplicable && (!showTotal || estimated)) {
    const amount = document.createElement("details");
    amount.className = "quota-money";
    amount.dataset.key = JSON.stringify([parent.dataset.group ?? "", label]);
    const summary = document.createElement("summary");
    const detail = document.createElement("p");
    if (estimated) {
      summary.textContent = showTotal ? "查看估算依据" : `${estimate.attribution === "correlated" ? "剩余条件估算" : "剩余估算"} ${money(estimate.estimatedRemainingUsd)}`;
      const interval = estimate.sampleStartAt && estimate.sampleEndAt ? `${new Date(estimate.sampleStartAt).toLocaleString()} → ${new Date(estimate.sampleEndAt).toLocaleString()} · ${estimate.sampleIntervals ?? 1} 个合格区间${estimate.quotaChanges ? ` / ${estimate.quotaChanges} 次额度下降` : ""}（范围内可能有排除区间） · ` : "";
      const tokens = typeof estimate.observedTokens === "number" ? `${estimate.observedTokens.toLocaleString()} tokens · ` : "";
      detail.textContent = `${interval}Pi 记录金额 ${money(estimate.observedCostUsd)} · ${tokens}账号额度下降 ${estimate.usedPercent} 个百分点 · 周期外推约 ${money(estimate.estimatedPeriodUsd)}。${estimate.note} 非账户余额。`;
    } else {
      summary.textContent = "金额暂不可估算";
      detail.textContent = estimate.note;
    }
    amount.append(summary, detail);
    container.append(amount);
  }
  if (estimate && !notApplicable && (estimate.unpricedRecords || estimate.ledgerStale)) {
    const warning = document.createElement("small");
    warning.className = "quota-estimate-note";
    warning.textContent = [estimate.unpricedRecords ? `${estimate.unpricedRecords} 条未计价，相关区间未用于校准` : "", estimate.ledgerStale ? "账本汇总已过期" : ""].filter(Boolean).join(" · ");
    container.append(warning);
  }
  parent.append(container);
}
// Keep open disclosures and keyboard focus stable during the five-second cache poll.
function updateQuotaContent(container, data, scope, build) {
  const fingerprint = JSON.stringify([scope, data]);
  if (container.dataset.content === fingerprint) return;
  const details = [...container.querySelectorAll("details[data-key]")];
  const sameScope = container.dataset.scope === scope;
  const openKeys = new Set(sameScope ? details.filter((item) => item.open).map((item) => item.dataset.key) : []);
  const focusedKey = sameScope ? document.activeElement?.closest("details[data-key]")?.dataset.key : undefined;
  const hadFocus = container.contains(document.activeElement);
  container.replaceChildren();
  build();
  container.dataset.content = fingerprint;
  container.dataset.scope = scope;
  for (const detail of container.querySelectorAll("details[data-key]")) {
    detail.open = openKeys.has(detail.dataset.key);
    if (hadFocus && detail.dataset.key === focusedKey) detail.querySelector("summary").focus({ preventScroll: true });
  }
}
function queryLabel(cache, partialError = false) {
  if (cache.error) return "查询失败";
  if (partialError) return "部分查询失败（使用可用数据）";
  if (cache.restored && cache.value) return "已加载上次读数，等待刷新";
  if (cache.value) return "查询成功";
  return cache.lastAttemptAt ? "查询中 / 尚无成功结果" : "等待首次查询";
}
function lastSuccess(cache) {
  return cache.value?.capturedAt ? new Date(cache.value.capturedAt).toLocaleString() : "尚无成功查询";
}
function renderProviderErrors(container, cache, extraErrors = []) {
  const messages = [
    ...(cache.error ? [`查询错误：${cache.error}${cache.value ? "；已保留上次成功结果" : "；尚无可保留结果"}`] : []),
    ...(cache.storageError ? [cache.storageError] : []),
    ...(cache.restored && cache.value ? ["已加载上次保存的读数；以最近成功时间为准，后台正在刷新。"] : []),
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
  if (cache.storageError) notice(container, cache.storageError);
  if (cache.error) notice(container, `查询错误：${cache.error}${cache.value ? "（保留上次成功结果）" : ""}`);
  for (const error of extraErrors.filter(Boolean)) notice(container, `额度汇总错误：${error}`);
}
function renderCodex(cache) {
  const viewingCurrent = !!latest.currentAccountId && latest.selectedAccountId === latest.currentAccountId;
  const selected = (latest.accounts ?? []).find((item) => item.id === latest.selectedAccountId)?.name ?? "所选账本";
  const result = viewingCurrent ? cache.value : undefined;
  $("codex-plan").textContent = viewingCurrent
    ? `${selected} · ${result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据"}`
    : `${selected} · 无法查询 Codex 实时额度及当期金额估算（仅当前登录账号可查询）`;
  const windows = $("codex-windows");
  updateQuotaContent(windows, [result, latest.quotaEstimates.codex], latest.selectedAccountId ?? "all", () => {
    quotaWindow(windows, WINDOW_LABELS.weekly, result?.weekly, viewingCurrent ? latest.quotaEstimates.codex.weekly : undefined, false, viewingCurrent);
    quotaWindow(windows, WINDOW_LABELS.fiveHour, result?.fiveHour, viewingCurrent ? latest.quotaEstimates.codex.fiveHour : undefined,
      result?.plan?.toLowerCase() === "pro" && !result.fiveHour, viewingCurrent);
  });
  $("codex-success").textContent = viewingCurrent ? `最近成功查询：${lastSuccess(cache)}` : "所选视图无可查询的 Codex 实时额度";
  renderProviderErrors($("codex-error"), viewingCurrent ? cache : {});
}
function modelGroupName(model) {
  const name = `${model.modelId} ${model.displayName ?? ""}`;
  if (/gemini/i.test(name)) return "Gemini 模型额度（旧版回退）";
  if (/claude|gpt/i.test(name)) return "Claude / GPT 模型额度（旧版回退）";
  return "其他模型额度（旧版回退）";
}
function renderAntigravity(cache) {
  const result = cache.value;
  $("agy-plan").textContent = `${result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据"} · 所有账本视图共享`;
  const container = $("agy-windows");
  updateQuotaContent(container, [result, latest.quotaEstimates.antigravity], "antigravity", () => {
    const groups = result?.groups ?? [];
    const models = result?.models ?? [];
    if (groups.length) {
      for (const [groupIndex, group] of groups.entries()) {
        const windows = orderedWindows(group.windows ?? [], latest.quotaEstimates.antigravity.groups[groupIndex]?.windows);
        // Additional groups remain scannable, with full windows available on demand.
        const collapsible = groupIndex > 0;
        const section = document.createElement(collapsible ? "details" : "section");
        section.className = collapsible ? "quota-group quota-group-more" : "quota-group";
        const heading = document.createElement(collapsible ? "summary" : "h4");
        heading.textContent = group.name;
        if (collapsible) {
          section.dataset.key = JSON.stringify(["group", group.name]);
          const summary = document.createElement("span");
          summary.className = "group-quota-summary";
          summary.textContent = windows.length ? `${windows.map(({ window }) => percent(window.remainingPercent)).join(" / ")} 剩余` : "查看额度";
          summary.title = windows.map(({ window, kind }) => `${WINDOW_LABELS[kind] ?? window.label}: ${percent(window.remainingPercent)}`).join(" · ");
          heading.append(summary);
        }
        section.append(heading);
        const items = document.createElement("div");
        items.className = "quota-windows";
        items.dataset.group = group.name;
        if (windows.length) {
          for (const { window, estimate, kind } of windows) {
            quotaWindow(items, WINDOW_LABELS[kind] ?? window.label, window, estimate);
          }
        } else {
          const candidates = models.filter((model) => new RegExp(group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${model.modelId} ${model.displayName ?? ""}`));
          if (candidates.length) {
            for (const model of candidates) quotaWindow(items, `${model.displayName ?? model.modelId} · 模型额度`, model);
            const fallbackNote = document.createElement("small");
            fallbackNote.className = "quota-estimate-note";
            fallbackNote.textContent = "模型回退数据未提供可识别的 5 小时 / 每周窗口，未推算金额。";
            section.append(fallbackNote);
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
        const fallbackNote = document.createElement("small");
        fallbackNote.className = "quota-estimate-note";
        fallbackNote.textContent = "旧版模型额度未提供可识别的 5 小时 / 每周窗口，未推算金额。";
        section.append(heading, items, fallbackNote);
        container.append(section);
      }
    } else {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = result ? "暂无额度窗口或模型额度数据。" : "尚无成功查询结果；额度数据未知。";
      container.append(empty);
    }
  });
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
function renderTrend(field, chartId, summaryId) {
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
  let priced = 0, unpriced = 0;
  for (const item of period === "days" ? latest.usage.timeline.days : latest.usage.timeline.hours) {
    if (counts.has(item.bucket) && (!selected || (item.provider === selected[0] && item.model === selected[1]))) {
      counts.set(item.bucket, counts.get(item.bucket) + item[field]);
      priced += item.pricedRecords;
      unpriced += item.unpricedRecords;
    }
  }
  const bucketValues = slots.map(({ bucket }) => counts.get(bucket));
  const cumulative = $("chart-view").value === "cumulative";
  let runningTotal = 0;
  const values = cumulative ? bucketValues.map((value) => (runningTotal += value)) : bucketValues;
  const peak = Math.max(0, ...values);
  const total = bucketValues.reduce((sum, value) => sum + value, 0);
  const label = selected ? `${selected[0]} / ${selected[1]}` : "全部模型";
  const isCost = field === "estimatedCostUsd";
  const format = isCost ? money : (value) => value.toLocaleString();
  const unit = isCost ? "（USD，估算）" : " tokens";
  $(summaryId).textContent = `${period === "days" ? "最近 30 天" : "最近 24 小时"} · ${label} · ${cumulative ? "时段累计" : "分时消耗"} · ${format(total)}${unit}${isCost ? ` · ${priced} 条已计价${unpriced ? `，${unpriced} 条未计价未纳入金额` : ""}` : ""}${latest.usage.stale ? "（账本汇总已过期）" : ""}`;
  const chart = $(chartId);
  chart.dataset.view = cumulative ? "cumulative" : "interval";
  chart.setAttribute("aria-label", `${label}在${period === "days" ? "最近30天" : "最近24小时"}的${isCost ? "估算金额" : "Token"}${cumulative ? "时段累计" : "分时"}消耗趋势，总计 ${format(total)}${unit}${isCost && unpriced ? `，${unpriced} 条未计价` : ""}`);
  chart.replaceChildren();
  const width = Math.max(260, chart.clientWidth || 520);
  const svg = svgElement("svg", { viewBox: `0 0 ${width} 210`, role: "presentation", "aria-hidden": "true" });
  const left = 58, right = width - 12, top = 16, bottom = 175;
  const axisFormat = (value) => isCost ? money(value) : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  for (let tick = 0; tick <= 2; tick++) {
    const y = bottom - tick * (bottom - top) / 2;
    svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 9, y: y + 4, class: "axis-label", "text-anchor": "end" }, axisFormat(isCost ? peak * tick / 2 : Math.round(peak * tick / 2))));
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
    const circle = svgElement("circle", { cx: x, cy: y, r: value ? 3 : 0, class: "chart-point" });
    circle.append(svgElement("title", {}, `${slots[index].label}${cumulative ? " 截至此刻时段累计" : " 分时消耗"}: ${format(value)}${unit}`));
    svg.append(circle);
    const tickStep = width < 380 ? (period === "days" ? 14 : 12) : (period === "days" ? 7 : 6);
    if (index === 0 || index === slots.length - 1 || (index % tickStep === 0 && index < slots.length - 3)) {
      svg.append(svgElement("text", { x, y: 201, class: "axis-label", "text-anchor": index === 0 ? "start" : index === slots.length - 1 ? "end" : "middle" }, slots[index].label));
    }
  }
  chart.append(svg);
  if (!total) notice(chart, isCost && unpriced ? "所选时段有未计价记录，无法计算这些记录的金额。" : `所选时间与模型暂无${isCost ? "可计价金额" : " Token 记录"}。`, !unpriced);
}
function renderCodexPeriodChart() {
  const chart = $("codex-period-chart");
  const kind = $("codex-period-kind").value;
  const periods = (latest.codexPeriods ?? []).filter((period) => period.kind === kind).slice(-24);
  const known = periods.filter((period) => typeof period.estimatedTotalUsd === "number" && Number.isFinite(period.estimatedTotalUsd));
  $("codex-period-summary").textContent = `最近 ${periods.length} 期 · ${known.length} 期有估算 · 每点代表一期（横轴不按实际时长）`;
  chart.setAttribute("aria-label", `OAI ${kind === "weekly" ? "weekly" : "5h"} 当期总金额估算，${periods.length} 期中 ${known.length} 期有估算`);
  chart.replaceChildren();
  if (!periods.length || !known.length) {
    notice(chart, periods.length ? "已记录周期，但尚无可计价的当期总金额估算。" : "尚无此账号的 OAI 周期记录。", true);
    return;
  }
  const width = Math.max(260, chart.clientWidth || 520);
  const svg = svgElement("svg", { viewBox: `0 0 ${width} 210`, role: "presentation", "aria-hidden": "true" });
  const left = 58, right = width - 14, top = 16, bottom = 170;
  const peak = Math.max(...known.map((period) => period.estimatedTotalUsd));
  for (let tick = 0; tick <= 2; tick++) {
    const y = bottom - tick * (bottom - top) / 2;
    svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: "grid-line" }));
    svg.append(svgElement("text", { x: left - 8, y: y + 4, class: "axis-label", "text-anchor": "end" }, money(peak * tick / 2)));
  }
  let line = [];
  for (const [index, period] of periods.entries()) {
    const x = left + (index + 0.5) * (right - left) / periods.length;
    const value = period.estimatedTotalUsd;
    const hasValue = typeof value === "number" && Number.isFinite(value);
    const y = hasValue ? bottom - (peak ? value / peak : 0) * (bottom - top) : bottom;
    if (!hasValue) {
      if (line.length > 1) svg.append(svgElement("path", { d: line.join(" "), class: "chart-line" }));
      line = [];
      const missing = svgElement("line", { x1: x - 4, x2: x + 4, y1: bottom, y2: bottom, class: "period-missing" });
      missing.append(svgElement("title", {}, `${new Date(period.startedAt).toLocaleString()} 起 · 暂无有效估算`));
      svg.append(missing);
    } else {
      line.push(`${line.length ? "L" : "M"}${x} ${y}`);
      svg.append(svgElement("line", { x1: x, x2: x, y1: bottom, y2: y, class: "period-stem" }));
      const marker = svgElement("circle", { cx: x, cy: y, r: 4, class: period.closedAt ? "chart-point" : "period-active" });
      const boundary = { increase: "额度增加", "reset-time": "重置时间变化", "plan-change": "套餐变化" }[period.boundary] ?? "";
      marker.append(svgElement("title", {}, `${new Date(period.startedAt).toLocaleString()} 起 · ${period.closedAt ? "已观察到下一期" : "尚未观察到下一期"} · ${period.attribution === "correlated" ? "条件估算（同区间可能有外部消耗）" : "总金额估算"} ${money(value)}${period.sampleIntervals ? ` · 累计 ${period.sampleIntervals} 个账本区间` : ""}${period.quotaChanges ? ` / ${period.quotaChanges} 次额度下降` : ""}${period.excludedIntervals ? ` · 排除 ${period.excludedIntervals} 个无 Pi 用量区间` : ""}${boundary ? ` · 下一期触发：${boundary}` : ""}`));
      svg.append(marker);
    }
    if (index === 0 || index === periods.length - 1 || index % Math.max(1, Math.ceil(periods.length / 5)) === 0) {
      svg.append(svgElement("text", { x, y: 200, class: "axis-label", "text-anchor": index === 0 ? "start" : index === periods.length - 1 ? "end" : "middle" },
        new Date(period.startedAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })));
    }
  }
  if (line.length > 1) svg.append(svgElement("path", { d: line.join(" "), class: "chart-line" }));
  chart.append(svg);
}
function renderChart() {
  const cumulative = $("chart-view").value === "cumulative";
  $("token-trend-title").textContent = cumulative ? "Token 累计消耗" : "Token 消耗";
  $("cost-trend-title").textContent = cumulative ? "累计估算金额" : "估算金额";
  $("chart-view-note").textContent = cumulative ? " · 累计从所选时段起点计算，非全部历史用量；未计价金额不纳入累计" : "";
  renderTrend("totalTokens", "chart", "chart-summary");
  renderTrend("estimatedCostUsd", "cost-chart", "cost-chart-summary");
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
    link.textContent = `${item.model}${item.effectiveFrom ? ` · ${new Date(item.effectiveFrom).toISOString().slice(0, 10)} 起` : ""}`;
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
  const account = $("usage-account");
  const accountChoices = latest.accounts ?? [];
  if (account.options.length !== accountChoices.length || accountChoices.some((choice, index) => account.options[index]?.value !== choice.id)) {
    account.replaceChildren();
    for (const choice of accountChoices) {
      const option = document.createElement("option");
      option.value = choice.id;
      option.textContent = choice.name;
      account.append(option);
    }
  }
  account.value = latest.selectedAccountId ?? "all";
  const profiles = latest.profiles ?? [];
  for (const id of ["account-switch-profile", "account-manage-profile", "account-reset-profile"]) {
    const select = $(id);
    const previous = select.value;
    if (select.options.length !== profiles.length || profiles.some((profile, index) => select.options[index]?.value !== profile.name)) {
      select.replaceChildren(...profiles.map((profile) => new Option(profile.name, profile.name)));
      select.value = profiles.some((profile) => profile.name === previous) ? previous : latest.currentProfile ?? profiles[0]?.name ?? "";
    }
  }
  $("account-current").textContent = latest.currentProfile ?? (latest.currentAccountId ? "尚未保存为 profile" : "未登录 / 无账号 ID");
  $("account-use").disabled = busy || !profiles.length;
  $("account-manage").disabled = busy || !profiles.length;
  $("account-delete").disabled = busy || !profiles.length || $("account-manage-profile").value === latest.currentProfile;
  $("account-reset-usage").disabled = busy || !profiles.length;
  const backupSelect = $("account-backup");
  const backups = latest.backups ?? [];
  const previousBackup = backupSelect.value;
  if (backupSelect.options.length !== backups.length || backups.some((path, index) => backupSelect.options[index]?.value !== path)) {
    backupSelect.replaceChildren(...backups.map((path) => new Option(path.split(/[\\/]/).pop(), path)));
    backupSelect.value = backups.includes(previousBackup) ? previousBackup : backups[0] ?? "";
  }
  $("account-restore").disabled = busy || !backups.length;
  $("account-restore-path").disabled = busy;
  if (latest.accountNotice && latest.accountNotice.at > lastAccountNoticeAt) {
    lastAccountNoticeAt = latest.accountNotice.at;
    $("account-feedback").textContent = latest.accountNotice.message;
    $("history-feedback").textContent = latest.accountNotice.message;
    const created = /^备份已创建：(.*?)（含 OAuth 凭据/.exec(latest.accountNotice.message);
    if (created) $("backup-restore-path").value = created[1];
  }
  const codex = latest.codex;
  const agy = latest.antigravity;
  renderCodex(codex);
  renderAntigravity(agy);
  renderCodexPeriodChart();
  const codexStatus = $("codex-query-status");
  codexStatus.replaceChildren();
  if (latest.currentAccountId && latest.selectedAccountId === latest.currentAccountId) statusDetails(codexStatus, codex);
  else row(codexStatus, "查询状态", "所选视图无法查询实时 Codex 额度");
  const agyStatus = $("agy-query-status");
  agyStatus.replaceChildren();
  statusDetails(agyStatus, agy, [agy.value?.summaryError]);
  const usage = latest.usage;
  $("overview-tokens").textContent = Number(usage.totals.totalTokens).toLocaleString();
  const ledgerName = accountChoices.find((choice) => choice.id === latest.selectedAccountId)?.name ?? "所选账号";
  $("overview-tokens-detail").textContent = !usage.records ? `${ledgerName} · 暂无本插件记录的用量`
    : `${ledgerName} · ${usage.records.toLocaleString()} 条账本记录${usage.stale ? " · 汇总已过期" : ""}${usage.invalidRecords ? ` · ${usage.invalidRecords.toLocaleString()} 条损坏记录已跳过` : ""}`;
  const pricing = usage.pricing;
  $("overview-cost").textContent = pricing.pricedRecords ? money(pricing.estimatedCostUsd) : "—";
  $("overview-cost-detail").textContent = `${ledgerName} · ${pricing.unpricedRecords
    ? `${pricing.pricedRecords ? "部分估算" : "暂无可估算费用"} · ${pricing.unpricedRecords.toLocaleString()} 条未计价（${pricing.unpricedTokens.toLocaleString()} tokens）`
    : pricing.pricedRecords ? `${pricing.pricedRecords.toLocaleString()} 条已计价 · API 标价` : "暂无可计价记录"}${usage.stale ? " · 账本汇总已过期" : ""}`;
  const context = latest.context;
  $("overview-context").textContent = typeof context?.percent === "number" ? `${Math.round(context.percent)}%` : "—";
  const contextKnown = typeof context?.percent === "number" && Number.isFinite(context.percent);
  $("context-meter").hidden = !contextKnown;
  $("context-meter").value = contextKnown ? Math.max(0, Math.min(100, context.percent)) : 0;
  $("context-meter").dataset.level = context?.percent >= 90 ? "low" : context?.percent >= 75 ? "warning" : "normal";
  $("overview-context-detail").textContent = context ? `${context.tokens === null ? "未知" : Number(context.tokens).toLocaleString()} / ${Number(context.contextWindow).toLocaleString()} tokens` : "当前模型未提供上下文窗口";
  const columns = [["Input", "input"], ["Output", "output"], ["Reasoning", "reasoning"], ["Cache read", "cacheRead"], ["Cache write", "cacheWrite"], ["Total tokens", "totalTokens"]];
  const tokens = $("tokens");
  tokens.replaceChildren();
  if (usage.stale) notice(tokens, usage.error || "Token 汇总已过期，显示上次有效结果");
  if (usage.childUsageIncomplete) notice(tokens, "部分 subagent 用量缺少可读的模型会话或运行元数据；已知 CLI 汇总记为未计价，Token 总量可能偏低。");
  if (usage.invalidRecords) notice(tokens, `已跳过 ${usage.invalidRecords.toLocaleString()} 条损坏记录。`);
  if (pricing.unpricedRecords) notice(tokens, `${pricing.unpricedRecords.toLocaleString()} 条用量没有可靠价格，估算费用未覆盖这些记录。`);
  if (!usage.records) notice(tokens, "暂无本插件记录的 Token 用量。", true);
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
    caption.className = "sr-only";
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
  renderPortSettings();
  if (document.activeElement !== $("interval")) $("interval").value = String(latest.config.refreshIntervalSeconds);
  if (!busy) {
    $("show-oai").checked = latest.config.showOaiInStatusbar;
    $("show-agy").checked = latest.config.showAgyInStatusbar;
  }
  $("last-check").textContent = `账本更新：${usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString() : "尚未成功读取"} · 页面读取：${new Date(latest.updatedAt).toLocaleTimeString()}`;
}
function renderPortSettings() {
  if (!latest) return;
  const configured = latest.config.dashboardPort;
  const running = latest.dashboard?.port ?? Number(location.port);
  if (!portDirty && document.activeElement !== $("dashboard-port")) $("dashboard-port").value = String(configured);
  $("port-state").textContent = `当前监听：127.0.0.1:${running} · 已保存端口：${configured}${running === configured ? "（正在使用）" : "（下次启动控制台生效）"}`;
  const fallbackFrom = latest.dashboard?.fallbackFrom;
  $("port-fallback").hidden = !fallbackFrom || configured !== fallbackFrom;
  $("port-fallback-message").textContent = fallbackFrom ? `启动端口 ${fallbackFrom} 被占用，已自动改用 ${running}。请在设置中保存可用端口；原配置未更改。` : "";
}
async function portAction(save) {
  if (busy || !control || !$("dashboard-port").reportValidity()) return;
  const port = Number($("dashboard-port").value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  setBusy(true);
  const feedback = $("port-feedback");
  feedback.dataset.error = "false";
  feedback.textContent = save ? "正在检测并保存端口…" : "正在检测端口占用…";
  try {
    const response = await fetch(save ? "/api/port" : "/api/port-check", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Quota-Control": control }, body: JSON.stringify({ port }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "端口操作失败");
    if (save) {
      latest.config.dashboardPort = port;
      portDirty = false;
      renderPortSettings();
      feedback.textContent = `已保存端口 ${port}，下次启动控制台生效，当前页面地址不变。`;
    } else {
      feedback.dataset.error = String(!result.available);
      feedback.textContent = result.message;
    }
  } catch (error) {
    feedback.dataset.error = "true";
    feedback.textContent = error.message || "端口操作失败";
  } finally { setBusy(false); }
}
async function load() {
  const requested = selectedAccount;
  const response = await fetch(`/api/state${requested ? `?account=${encodeURIComponent(requested)}` : ""}`, { cache: "no-store" });
  if (!response.ok) throw new Error("本地会话已结束，请在 Pi 中重新运行 /quota-console");
  const state = await response.json();
  if (selectedAccount !== requested) return;
  // A switch leaves the old profile in the account list. Do not keep viewing its
  // historical ledger when this tab was following the previously active account.
  if (latest?.currentAccountId && requested === latest.currentAccountId
    && state.currentAccountId !== latest.currentAccountId) {
    selectedAccount = undefined;
    return load();
  }
  control = state.control;
  latest = state;
  selectedAccount = state.selectedAccountId;
  render();
  $("connection-status").dataset.state = "connected";
  $("connection-status").textContent = "本地已连接";
  if (!busy) $("feedback").textContent = "";
}
function loadError(error) {
  $("connection-status").dataset.state = "offline";
  $("connection-status").textContent = "连接已断开";
  $("feedback").textContent = error.message || "无法连接本地 Pi 会话";
}
function syncStatusbarControls() {
  if (!latest) return;
  $("show-oai").checked = latest.config.showOaiInStatusbar;
  $("show-agy").checked = latest.config.showAgyInStatusbar;
}
function setBusy(value) {
  busy = value;
  for (const id of ["refresh", "interval", "interval-submit", "show-oai", "show-agy", "account-add", "account-history",
    "account-name", "account-import-name", "account-import-path", "backup-location", "backup-directory", "backup-restore-path",
    "account-backup-create", "account-restore-path", "dashboard-port", "port-check", "port-submit", "port-use-current"]) $(id).disabled = value;
  $("refresh").textContent = value ? "处理中…" : "↻ 刷新额度";
  $("account-use").disabled = value || !(latest?.profiles?.length);
  $("account-switch-confirm").disabled = value || !(latest?.profiles?.length);
  $("account-manage").disabled = value || !(latest?.profiles?.length);
  $("account-delete").disabled = value || !(latest?.profiles?.length) || $("account-manage-profile").value === latest?.currentProfile;
  $("account-reset-usage").disabled = value || !(latest?.profiles?.length);
  $("account-restore").disabled = value || !(latest?.backups?.length);
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
async function queueAccountCommand(command, args = "", feedbackId = "account-feedback", dialogId) {
  if (busy || !control) return;
  setBusy(true);
  $(feedbackId).textContent = "正在发送请求…";
  try {
    const response = await fetch("/api/account-command", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Quota-Control": control },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "操作失败");
    const message = command === "use"
      ? "已提交账号切换；请在 Pi 窗口确认。凭据切换后当前会话不变，本页将跟随新账号。"
      : "已发送到 Pi；如需确认，请查看 Pi 窗口。完成后本页会自动更新。";
    $(feedbackId).textContent = message;
    if (dialogId) { $(dialogId).close(); $("account-feedback").textContent = message; }
  } catch (error) {
    $(feedbackId).textContent = error.message || "操作失败";
  } finally { setBusy(false); }
}
// Hoverable, keyboard-accessible help; click pins it for touch users, Escape dismisses it.
for (const tip of document.querySelectorAll(".help-tip")) {
  const button = tip.querySelector("button");
  const content = tip.querySelector('[role="tooltip"]');
  let pinned = false;
  let hovered = false;
  const show = (visible) => {
    content.hidden = !visible;
    button.setAttribute("aria-expanded", String(visible));
    content.classList.remove("help-tooltip-above");
    if (visible && content.getBoundingClientRect().bottom > window.innerHeight - 16 && button.getBoundingClientRect().top > content.offsetHeight + 16) {
      content.classList.add("help-tooltip-above");
    }
  };
  tip.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    hovered = true;
    show(true);
  });
  tip.addEventListener("pointerleave", () => {
    hovered = false;
    if (!pinned && document.activeElement !== button) show(false);
  });
  button.addEventListener("focus", () => show(true));
  button.addEventListener("blur", () => { pinned = false; if (!hovered) show(false); });
  button.addEventListener("click", () => { pinned = !pinned; show(pinned); });
  document.addEventListener("click", (event) => { if (!tip.contains(event.target)) { pinned = false; show(false); } });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { pinned = false; show(false); } });
}
$("port-open-settings").addEventListener("click", () => {
  $("settings").open = true;
  $("settings").scrollIntoView({ block: "start" });
  $("dashboard-port").focus({ preventScroll: true });
});
$("port-use-current").addEventListener("click", () => {
  $("dashboard-port").value = String(latest?.dashboard?.port ?? Number(location.port));
  portDirty = true;
  $("port-feedback").textContent = "已填入当前端口，点击「保存端口」后用于下次启动。";
});
$("dashboard-port").addEventListener("input", () => { portDirty = true; $("port-feedback").textContent = ""; });
$("port-check").addEventListener("click", () => { void portAction(false); });
$("port-form").addEventListener("submit", (event) => { event.preventDefault(); void portAction(true); });
const profileName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
$("account-use").addEventListener("click", () => { $("account-switch-dialog").showModal(); });
$("account-add").addEventListener("click", () => { $("account-add-dialog").showModal(); });
$("account-manage").addEventListener("click", () => { $("account-manage-dialog").showModal(); });
$("account-history").addEventListener("click", () => { $("account-history-dialog").showModal(); });
for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => { $(button.dataset.closeDialog).close(); });
}
$("account-save-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("account-name").value.trim();
  if (profileName(name)) void queueAccountCommand("save", name, "account-add-feedback", "account-add-dialog");
});
$("account-import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("account-import-name").value.trim();
  const path = $("account-import-path").value.trim();
  if (!profileName(name) || !path || /[\r\n\u0000]/.test(path)) {
    $("account-add-feedback").textContent = "名称或 Pi 机器上的 JSON 路径无效。";
    return;
  }
  void queueAccountCommand("import", `${name} ${path}`, "account-add-feedback", "account-add-dialog");
});
$("account-switch-confirm").addEventListener("click", () => {
  const name = $("account-switch-profile").value;
  if (profileName(name) && confirm(`切换到 ${name}？Pi 中还会要求确认；当前会话不会重建。`)) {
    void queueAccountCommand("use", name, "account-switch-feedback", "account-switch-dialog");
  }
});
$("account-manage-profile").addEventListener("change", () => {
  $("account-delete").disabled = busy || $("account-manage-profile").value === latest?.currentProfile;
});
$("account-delete").addEventListener("click", () => {
  const name = $("account-manage-profile").value;
  if (profileName(name) && confirm(`备份后删除 ${name} 的保存凭据？历史用量仍保留。`)) void queueAccountCommand("delete", name, "account-manage-feedback", "account-manage-dialog");
});
$("account-reset-usage").addEventListener("click", () => {
  const name = $("account-reset-profile").value;
  if (profileName(name) && confirm(`先备份，再清除 ${name} 的本地 Codex 用量？不会重置 OpenAI 实际额度。`)) void queueAccountCommand("reset-usage", name, "history-feedback");
});
$("backup-location").addEventListener("change", () => {
  $("backup-directory").hidden = $("backup-location").value !== "custom";
});
$("account-backup-create").addEventListener("click", () => {
  const directory = $("backup-location").value === "custom" ? $("backup-directory").value.trim() : "";
  if ($("backup-location").value === "custom" && !directory) {
    $("history-feedback").textContent = "请输入 Pi 机器上的私有目录绝对路径。";
    return;
  }
  void queueAccountCommand("backup", directory, "history-feedback");
});
function requestRestore(path) {
  if (path && confirm(`导入备份 ${path.split(/[\\/]/).pop()}？Pi 中还会显示内容并要求确认。`)) {
    void queueAccountCommand("restore", path, "history-feedback");
  }
}
$("account-restore").addEventListener("click", () => { requestRestore($("account-backup").value); });
$("account-restore-path").addEventListener("click", () => {
  const path = $("backup-restore-path").value.trim();
  if (path) requestRestore(path);
  else $("history-feedback").textContent = "请输入 Pi 机器上的备份文件路径。";
});
$("refresh").addEventListener("click", () => { void action("/api/refresh"); });
$("usage-account").addEventListener("change", (event) => {
  selectedAccount = event.currentTarget.value;
  void load().catch(loadError);
});
$("quota-view").addEventListener("change", (event) => {
  const view = event.currentTarget.value;
  $("provider-grid").dataset.quotaView = view;
  $("quota-pie-legend").hidden = view !== "pie";
});
$("codex-period-details").addEventListener("toggle", (event) => {
  if (event.currentTarget.open && latest) renderCodexPeriodChart();
});
$("codex-period-kind").addEventListener("change", renderCodexPeriodChart);
$("chart-view").addEventListener("change", renderChart);
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
if (typeof ResizeObserver !== "undefined") {
  let chartWidth;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === chartWidth) return;
    chartWidth = entry.contentRect.width;
    renderChart();
  }).observe($("chart"));
  let periodWidth;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === periodWidth) return;
    periodWidth = entry.contentRect.width;
    if (latest) renderCodexPeriodChart();
  }).observe($("codex-period-chart"));
}
void load().catch(loadError);
setInterval(() => { if (!busy) void load().catch(loadError); }, 5000);
setInterval(renderCountdown, 1000);
