"use strict";

const $ = (id) => document.getElementById(id);
let latest;
let control;
let busy = false;
let selectedAccount;
let lastAccountNoticeAt = 0;
let portDirty = false;
let requestSequence = 0;
let pollTimer;
let countdownTimer;
const CARD_SETTINGS = [["codex", "showCodexCard"], ["claude", "showClaudeCard"], ["grok", "showGrokCard"], ["agy", "showAgyCard"]];
const ACCOUNT_CARDS = [["codex", "openai-codex", "Codex"], ["claude", "anthropic", "Claude"], ["grok", "xai", "Grok"]];
let managedProvider = "openai-codex";
const dialogOpeners = new WeakMap();

function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
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
function infoHelp(label, key) {
  const details = document.createElement("details");
  details.className = "info-help";
  if (key) details.dataset.key = key;
  const summary = document.createElement("summary");
  summary.textContent = "?";
  summary.setAttribute("aria-label", label);
  const content = document.createElement("div");
  content.className = "help-content";
  const heading = document.createElement("strong");
  heading.textContent = label;
  content.append(heading);
  details.append(summary, content);
  return { details, content };
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
function quotaWindow(parent, label, window, estimate, notApplicable = false) {
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
  const resetKnown = typeof window?.resetAt === "number" && Number.isFinite(window.resetAt);
  reset.textContent = resetKnown ? countdown(window.resetAt) : "";
  reset.hidden = !resetKnown;
  if (resetKnown) reset.dataset.resetAt = String(window.resetAt);
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  bar.dataset.known = String(known);
  bar.append(meter);
  container.append(name, valueRow, bar, quotaPie(label, remaining, notApplicable), reset);
  const estimated = Number.isFinite(estimate?.estimatedRemainingUsd);
  if (estimate || notApplicable) {
    const { details: amount, content } = infoHelp(`${label} · 额度与估算说明`, JSON.stringify([parent.dataset.group ?? "", label]));
    amount.classList.add("quota-money");
    const detail = document.createElement("p");
    if (notApplicable) {
      detail.textContent = "Pro 暂无 5 小时限制";
    } else if (estimated) {
      const value = document.createElement("span");
      value.className = "quota-estimate-value";
      value.textContent = `剩余估算 ${money(estimate.estimatedRemainingUsd)}`;
      container.append(value);
      const interval = estimate.sampleStartAt && estimate.sampleEndAt ? `${new Date(estimate.sampleStartAt).toLocaleString()} → ${new Date(estimate.sampleEndAt).toLocaleString()} · ${estimate.sampleIntervals ?? 1} 个合格区间${estimate.quotaChanges ? ` / ${estimate.quotaChanges} 次额度下降` : ""}（范围内可能有排除区间） · ` : "";
      const tokens = typeof estimate.observedTokens === "number" ? `${estimate.observedTokens.toLocaleString()} tokens · ` : "";
      detail.textContent = `${interval}Pi 记录金额 ${money(estimate.observedCostUsd)} · ${tokens}账号额度下降 ${estimate.usedPercent} 个百分点。${estimate.note ?? ""} 非账户余额。`;
    } else {
      detail.textContent = estimate?.note ?? "等待额度读数，暂不可估算金额。";
    }
    content.append(detail);
    if (estimated && estimate?.attribution === "correlated" && !notApplicable) {
      const caveat = document.createElement("p");
      caveat.className = "quota-estimate-note";
      caveat.textContent = "条件估算 · 同区间可能含外部消耗";
      content.append(caveat);
    }
    if (estimate && !notApplicable && (estimate.unpricedRecords || estimate.ledgerStale)) {
      const warning = document.createElement("p");
      warning.className = "quota-estimate-note";
      warning.textContent = [estimate.unpricedRecords ? `${estimate.unpricedRecords} 条未计价，相关区间未用于校准` : "", estimate.ledgerStale ? "账本汇总已过期" : ""].filter(Boolean).join(" · ");
      content.append(warning);
    }
    container.append(amount);
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
  if (cache.historical) return "历史读数（非实时，不自动切换查询）";
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
    ...(cache.restored && cache.value ? [cache.historical ? "历史账号读数，不代表当前剩余额度；请查看读数时间。" : "已加载上次保存的读数；以最近成功时间为准，后台正在刷新。"] : []),
    ...extraErrors.filter(Boolean).map((error) => `额度数据提示：${error}`),
  ];
  const fingerprint = JSON.stringify(messages);
  if (container.dataset.messages === fingerprint) return;
  container.dataset.messages = fingerprint;
  container.replaceChildren();
  for (const message of messages) notice(container, message);
  const help = container.closest(".provider-help");
  if (help) help.dataset.state = messages.length ? "warning" : "normal";
}
function statusDetails(container, cache, extraErrors = []) {
  row(container, "查询状态", queryLabel(cache, extraErrors.some(Boolean)));
  row(container, "最近成功时间", lastSuccess(cache));
  if (cache.storageError) notice(container, cache.storageError);
  if (cache.error) notice(container, `查询错误：${cache.error}${cache.value ? "（保留上次成功结果）" : ""}`);
  for (const error of extraErrors.filter(Boolean)) notice(container, `额度汇总错误：${error}`);
}
function renderCardAccount(prefix, provider, cache) {
  const current = latest.currentAccounts?.[provider];
  const legacy = latest.currentAccounts === undefined && provider === "openai-codex"
    ? (latest.accounts ?? []).find((a) => a.id === latest.currentAccountId)?.name ?? latest.currentProfile : undefined;
  const name = current?.name ?? legacy ?? "未登录 / 身份未确认";
  const label = $(`${prefix}-account`);
  label.textContent = `当前账号：${name}`;
  label.title = label.textContent;
  $(`${prefix}-account-current`).textContent = name;
  const owner = latest.quotaAccounts?.[provider], quota = $(`${prefix}-quota-account`);
  const historical = cache.historical || owner?.current === false;
  quota.hidden = !owner || (!historical && owner.id === current?.id);
  quota.textContent = owner ? `额度账号：${owner.name}${historical ? " · 历史读数（非实时）" : ""}` : "";
  quota.title = quota.textContent;
}
function renderCardVisibility() {
  if (!latest) return;
  let count = 0;
  for (const [prefix, key] of CARD_SETTINGS) {
    const card = $(`${prefix}-card`);
    card.hidden = latest.config[key] === false;
    if (!card.hidden) count++;
  }
  $("provider-grid").style.setProperty("--provider-columns", String(Math.max(1, count)));
  $("provider-grid").style.setProperty("--provider-compact-columns", String(Math.max(1, Math.min(2, count))));
  $("quota-empty-state").hidden = count !== 0;
}
function renderCodex(cache) {
  renderCardAccount("codex", "openai-codex", cache);
  const owner = latest.quotaAccounts?.["openai-codex"];
  const identifiedCards = latest.quotaAccounts !== undefined;
  const viewingCurrent = identifiedCards || (!!latest.currentAccountId && latest.selectedAccountId === latest.currentAccountId);
  const selected = owner?.name ?? (identifiedCards ? "Codex · 未登录 / 身份未确认" : (latest.accounts ?? []).find((item) => item.id === latest.selectedAccountId)?.name ?? "所选账本");
  const result = viewingCurrent ? cache.value : undefined;
  $("codex-plan").textContent = viewingCurrent
    ? `${selected} · ${cache.historical ? "历史读数（非实时）" : "当前登录"} · ${result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据"}`
    : `${selected} · 无法查询 Codex 实时额度（仅当前登录账号可查询）`;
  const windows = $("codex-windows");
  updateQuotaContent(windows, [result], owner?.id ?? latest.selectedAccountId ?? "all", () => {
    quotaWindow(windows, WINDOW_LABELS.weekly, result?.weekly);
    quotaWindow(windows, WINDOW_LABELS.fiveHour, result?.fiveHour, undefined,
      result?.plan?.toLowerCase() === "pro" && !result.fiveHour);
  });
  $("codex-success").textContent = viewingCurrent ? `${cache.historical ? "历史读数时间" : "最近成功查询"}：${lastSuccess(cache)}` : "所选视图无可查询的 Codex 实时额度";
  renderProviderErrors($("codex-error"), viewingCurrent ? cache : {});
}
function renderClaude(cache) {
  renderCardAccount("claude", "anthropic", cache);
  const result = cache?.value;
  const owner = latest.quotaAccounts?.anthropic;
  $("claude-plan").textContent = `${owner?.name ?? "Claude · 未登录 / 身份未确认"} · ${cache.historical ? "历史读数（非实时）" : "当前登录"}${result ? "" : " · 等待额度数据"}`;
  const windows = $("claude-windows");
  updateQuotaContent(windows, [result, latest.quotaEstimates?.claude], owner?.id ?? "claude", () => {
    quotaWindow(windows, WINDOW_LABELS.weekly, result?.weekly, latest.quotaEstimates?.claude?.weekly);
    quotaWindow(windows, WINDOW_LABELS.fiveHour, result?.fiveHour, latest.quotaEstimates?.claude?.fiveHour);
  });
  $("claude-success").textContent = `${cache.historical ? "历史读数时间" : "最近成功查询"}：${lastSuccess(cache)}`;
  renderProviderErrors($("claude-error"), cache);
}
function grokWindowLabel(window) {
  if (window?.label === "weekly") return "Weekly Credit Remaining";
  if (window?.label === "monthly") return "Monthly Credit Remaining";
  return "Credit Remaining";
}
function renderGrok(cache) {
  renderCardAccount("grok", "xai", cache);
  const result = cache?.value;
  const owner = latest.quotaAccounts?.xai;
  $("grok-plan").textContent = `${owner?.name ?? "Grok · 未登录 / 身份未确认"} · ${cache.historical ? "历史读数（非实时）" : "当前登录"}${result?.plan ? ` · ${result.plan}` : ""} · 共享额度，非 API 余额`;
  const windows = $("grok-windows");
  updateQuotaContent(windows, [result], owner?.id ?? "grok", () => {
    quotaWindow(windows, grokWindowLabel(result?.credit), result?.credit);
  });
  $("grok-success").textContent = `${cache.historical ? "历史读数时间" : "最近成功查询"}：${lastSuccess(cache)}`;
  renderProviderErrors($("grok-error"), cache);
}
function modelGroupName(model) {
  const name = `${model.modelId} ${model.displayName ?? ""}`;
  if (/gemini/i.test(name)) return "Gemini 模型额度（旧版回退）";
  if (/claude|gpt/i.test(name)) return "Claude / GPT 模型额度（旧版回退）";
  return "其他模型额度（旧版回退）";
}
function renderAntigravity(cache) {
  const result = cache.value;
  $("agy-plan").textContent = `${result?.plan ? `计划：${result.plan}` : result ? "计划信息未提供" : "等待额度数据"} · 独立只读登录，不参与 OAuth 账号管理`;
  const container = $("agy-windows");
  updateQuotaContent(container, [result, latest.quotaEstimates?.antigravity], "antigravity", () => {
    const groups = result?.groups ?? [];
    const models = result?.models ?? [];
    if (groups.length) {
      for (const [groupIndex, group] of groups.entries()) {
        const windows = orderedWindows(group.windows ?? [], latest.quotaEstimates?.antigravity?.groups?.[groupIndex]?.windows);
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
            const help = infoHelp("模型额度说明", JSON.stringify(["fallback", group.name]));
            notice(help.content, "模型回退数据未提供可识别的 5 小时 / 每周窗口，未推算金额。", true);
            section.append(help.details);
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
        const help = infoHelp("模型额度说明", JSON.stringify(["fallback", name]));
        notice(help.content, "旧版模型额度未提供可识别的 5 小时 / 每周窗口，未推算金额。", true);
        section.append(heading, help.details, items);
        container.append(section);
      }
    } else {
      const empty = document.createElement("p");
      empty.className = "quota-empty";
      empty.textContent = "—";
      empty.setAttribute("aria-label", result ? "暂无额度窗口或模型额度数据" : "尚无成功查询结果；额度数据未知");
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
function renderModelComparison() {
  if (!latest) return;
  const period = $("model-comparison-period").value;
  const isCost = $("model-comparison-metric").value === "cost";
  const timeline = latest.usage.timeline;
  const slots = new Set(period === "days" ? Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${timeline.today}T12:00:00`);
    date.setDate(date.getDate() - index);
    return calendarDay(date);
  }) : Array.from({ length: 24 }, (_, index) => String(timeline.currentHour - index * 3600000)));
  const groups = new Map();
  for (const item of period === "days" ? timeline.days : timeline.hours) {
    if (!slots.has(item.bucket)) continue;
    const key = JSON.stringify([item.provider, item.model]);
    const group = groups.get(key) ?? { provider: item.provider, model: item.model, totalTokens: 0, estimatedCostUsd: 0, pricedRecords: 0, unpricedRecords: 0 };
    for (const field of ["totalTokens", "estimatedCostUsd", "pricedRecords", "unpricedRecords"]) group[field] += item[field];
    groups.set(key, group);
  }
  const field = isCost ? "estimatedCostUsd" : "totalTokens";
  const models = [...groups.values()].sort((a, b) => {
    // An unknown price is not a zero-dollar model; keep it after measured values.
    if (isCost && !!a.pricedRecords !== !!b.pricedRecords) return a.pricedRecords ? -1 : 1;
    return b[field] - a[field] || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
  });
  const total = models.reduce((sum, item) => sum + item[field], 0);
  const peak = models.reduce((max, item) => Math.max(max, !isCost || item.pricedRecords > 0 ? item[field] : 0), 0);
  const priced = models.reduce((sum, item) => sum + item.pricedRecords, 0);
  const unpriced = models.reduce((sum, item) => sum + item.unpricedRecords, 0);
  const totalKnown = models.length > 0 && (!isCost || priced > 0);
  const format = isCost ? money : (value) => value.toLocaleString();
  $("model-comparison-total").textContent = totalKnown ? `${format(total)}${isCost && unpriced ? "*" : ""}` : "—";
  $("model-comparison-unit").textContent = isCost ? "USD" : "Tokens";
  $("model-comparison-note").textContent = `${models.length} 个模型${isCost ? ` · ${priced} 条已计价${unpriced ? ` · ${unpriced} 条未计价未纳入金额` : ""}` : " · Total tokens，Reasoning 不重复计入"}${latest.usage.stale ? " · 账本汇总已过期，显示上次有效结果" : ""}`;
  $("model-comparison-empty").hidden = models.length > 0;
  const list = $("model-comparison-list");
  list.setAttribute("aria-label", `${period === "days" ? "最近 7 天" : "最近 24 小时"}各模型${isCost ? "估算金额" : "Token"}对比`);
  const fingerprint = JSON.stringify([latest.selectedAccountId, period, isCost, models]);
  if (list.dataset.content === fingerprint) return;
  list.dataset.content = fingerprint;
  const previousScroll = list.dataset.scope === latest.selectedAccountId ? list.scrollTop : 0;
  list.dataset.scope = latest.selectedAccountId;
  list.replaceChildren();
  for (const item of models) {
    const known = !isCost || item.pricedRecords > 0;
    const value = known ? `${format(item[field])}${isCost && item.unpricedRecords ? "*" : ""}` : "未计价";
    const entry = document.createElement("li");
    entry.className = "comparison-item";
    const header = document.createElement("div");
    header.className = "comparison-item-heading";
    const name = document.createElement("span");
    name.className = "comparison-model-name";
    name.textContent = item.model;
    name.title = `${item.provider} / ${item.model}`;
    if (models.some((other) => other !== item && other.model === item.model)) name.textContent += ` · ${item.provider}`;
    const amount = document.createElement("strong");
    amount.className = "comparison-model-value";
    amount.textContent = value;
    header.append(name, amount);
    const track = document.createElement("div");
    track.className = "comparison-track";
    track.dataset.known = String(known);
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.style.width = `${known && peak > 0 ? Math.min(100, Math.max(0, item[field] / peak * 100)) : 0}%`;
    track.append(bar);
    entry.append(header, track);
    list.append(entry);
  }
  list.scrollTop = previousScroll;
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
  if (account.options.length !== accountChoices.length || accountChoices.some((choice, index) => account.options[index]?.value !== choice.id || account.options[index]?.textContent !== choice.name)) {
    account.replaceChildren();
    for (const choice of accountChoices) {
      const option = document.createElement("option");
      option.value = choice.id;
      option.textContent = choice.name;
      account.append(option);
    }
  }
  account.value = latest.selectedAccountId ?? "all";
  $("ledger-selection").textContent = accountChoices.find((choice) => choice.id === account.value)?.name ?? "所选账本";
  account.title = $("ledger-selection").textContent;
  renderAccountControls();
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
  renderClaude(latest.claude ?? {});
  renderGrok(latest.grok ?? {});
  renderAntigravity(agy);
  const codexStatus = $("codex-query-status");
  codexStatus.replaceChildren();
  if (latest.quotaAccounts !== undefined || (latest.currentAccountId && latest.selectedAccountId === latest.currentAccountId)) statusDetails(codexStatus, codex);
  else row(codexStatus, "查询状态", "所选视图无法查询实时 Codex 额度");
  const claudeStatus = $("claude-query-status");
  claudeStatus.replaceChildren();
  statusDetails(claudeStatus, latest.claude ?? {});
  const grokStatus = $("grok-query-status");
  grokStatus.replaceChildren();
  statusDetails(grokStatus, latest.grok ?? {});
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
  renderModelComparison();
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
    table.className = "models-table";
    const caption = document.createElement("caption");
    caption.className = "sr-only";
    caption.textContent = "按 Provider 和模型分组，Total tokens 降序";
    table.append(caption);
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Provider", "Model", ...columns.map(([name]) => name), "估算费用 USD", "操作"]) {
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
      const actions = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button-danger usage-delete";
      const icon = svgElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
      icon.append(svgElement("path", { d: "M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" }));
      remove.append(icon);
      remove.title = "删除本地用量记录";
      remove.setAttribute("aria-label", `删除 ${item.provider} / ${item.model} 的本地用量记录`);
      remove.disabled = busy || usage.stale;
      remove.addEventListener("click", () => { void deleteUsageRow(item); });
      actions.append(remove);
      tr.append(actions);
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
  renderCardVisibility();
  if (!busy) syncDisplayControls();
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
function safeRender() {
  try {
    render();
    return true;
  } catch (error) {
    $("feedback").textContent = `页面渲染出错：${error.message}`;
    return false;
  }
}
async function load() {
  const requestId = ++requestSequence;
  const requested = selectedAccount;
  let state;
  try {
    const response = await fetch(`/api/state${requested ? `?account=${encodeURIComponent(requested)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error("本地会话已结束，请在 Pi 中重新运行 /quota-console");
    state = await response.json();
  } catch (error) {
    if (requestId === requestSequence && selectedAccount === requested) loadError(error);
    return false;
  }
  if (requestId !== requestSequence || selectedAccount !== requested) return false;
  control = state.control;
  latest = state;
  selectedAccount = state.selectedAccountId;
  $("connection-status").dataset.state = "connected";
  $("connection-status").setAttribute("aria-label", "本地已连接");
  $("connection-status").title = "本地已连接";
  if (!safeRender()) return false;
  if (!busy) $("feedback").textContent = "";
  return true;
}
function loadError(error) {
  $("connection-status").dataset.state = "offline";
  $("connection-status").setAttribute("aria-label", "连接已断开");
  $("connection-status").title = "连接已断开";
  $("feedback").textContent = error.message || "无法连接本地 Pi 会话";
}
function syncDisplayControls() {
  if (!latest) return;
  $("show-oai").checked = latest.config.showOaiInStatusbar;
  $("show-claude").checked = latest.config.showClaudeInStatusbar;
  $("show-agy").checked = latest.config.showAgyInStatusbar;
  $("show-grok").checked = latest.config.showGrokInStatusbar !== false;
  for (const [prefix, key] of CARD_SETTINGS) $(`show-${prefix}-card`).checked = latest.config[key] !== false;
  renderCardVisibility();
}
function setBusy(value) {
  busy = value;
  for (const id of ["refresh", "interval", "interval-submit", "show-oai", "show-claude", "show-agy", "show-grok", "show-codex-card", "show-claude-card", "show-grok-card", "show-agy-card",
    "account-name", "account-import-name", "account-import-path", "account-note", "backup-location", "backup-directory", "backup-restore-path",
    "account-backup-create", "account-restore-path", "dashboard-port", "port-check", "port-submit", "port-use-current"]) $(id).disabled = value;
  $("refresh").textContent = value ? "处理中…" : "↻ 刷新额度";
  updateAccountButtons();
  $("account-restore").disabled = value || !(latest?.backups?.length);
  for (const button of document.querySelectorAll(".usage-delete")) button.disabled = value || !!latest?.usage?.stale;
}
async function deleteUsageRow(item) {
  if (busy || !control || !latest || latest.usage.stale) return;
  const account = latest.selectedAccountId;
  if (!account) return;
  const count = item.pricedRecords + item.unpricedRecords;
  const scope = account === "all" ? "总体用量" : latest.accounts?.find((a) => a.id === account)?.name ?? "当前统计范围";
  if (!confirm(`先自动备份，再删除 ${scope}中 ${item.provider} / ${item.model} 的 ${count} 条现有本地记录？统计及趋势将同步扣除；不会影响 Provider 实际额度。`)) return;
  setBusy(true);
  $("feedback").textContent = "正在备份并删除记录…";
  try {
    const response = await fetch("/api/usage-delete", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Quota-Control": control },
      body: JSON.stringify({ account, provider: item.provider, model: item.model }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "删除失败");
    if (await load()) $("feedback").textContent = `已删除 ${result.removed} 条本地记录（删除前已备份）。`;
  } catch (error) {
    $("feedback").textContent = error.message || "删除失败";
  } finally { setBusy(false); }
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
    // A successful save remains applied even if the subsequent state read goes offline.
    if (path === "/api/cards") { Object.assign(latest.config, body); renderCardVisibility(); }
    if (await load()) $("feedback").textContent = "已更新";
    else syncDisplayControls();
  } catch (error) {
    syncDisplayControls();
    $("feedback").textContent = error.message || "操作失败";
  } finally {
    setBusy(false);
    syncDisplayControls();
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
      ? "已提交账号切换；请在 Pi 窗口确认。当前会话、模型及账本筛选均不变。"
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
// Delegation also covers quota help rebuilt by the cache poll.
document.addEventListener("click", (event) => {
  for (const detail of document.querySelectorAll(".info-help[open]")) {
    if (!detail.contains(event.target)) detail.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const detail of document.querySelectorAll(".info-help[open]")) {
    if (detail.contains(document.activeElement)) detail.querySelector("summary").focus();
    detail.open = false;
  }
});
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
function providerOf(item) { return item.provider ?? "openai-codex"; }
function scopedProfiles(provider = managedProvider) { return (latest?.profiles ?? []).filter((p) => providerOf(p) === provider); }
function scopedIdentities() { return (latest?.accounts ?? []).filter((a) => a.key && providerOf(a) === managedProvider); }
function profileValue(p) { return p.provider ? `${p.provider}/${p.name}` : p.name; }
function profileArgs(value) {
  const p = scopedProfiles().find((p) => profileValue(p) === value);
  // Legacy profiles are Codex too: never let the current model choose their provider.
  return p && profileName(p.name) ? `${managedProvider} ${p.name}` : undefined;
}
function selectedProfileIsCurrent() {
  const p = scopedProfiles().find((p) => profileValue(p) === $("account-manage-profile").value);
  return !!p && (p.current === true || (p.key && latest?.currentAccounts?.[managedProvider]?.id === `account:${p.key}`)
    || (p.current === undefined && providerOf(p) === "openai-codex" && p.name === latest?.currentProfile));
}
function renderAccountControls() {
  const profiles = scopedProfiles(), identities = scopedIdentities();
  const choices = profiles.map((p) => [p.displayName ? `${p.displayName}${p.current ? "（当前）" : ""}` : p.name, profileValue(p)]);
  for (const id of ["account-switch-profile", "account-manage-profile"]) syncChoices($(id), choices);
  syncChoices($("account-reset-profile"), latest.currentAccounts !== undefined
    ? identities.map((a) => [a.name, a.id]) : profiles.map((p) => [p.name, p.name]));
  const previousNote = $("account-note-target").value;
  syncChoices($("account-note-target"), identities.map((a) => [a.name, a.id]));
  if (previousNote !== $("account-note-target").value || (!$("account-note").dataset.dirty && document.activeElement !== $("account-note"))) syncNote();
  updateAccountButtons();
}
function updateAccountButtons() {
  for (const [prefix, provider] of ACCOUNT_CARDS) {
    $(`${prefix}-account-use`).disabled = busy || !scopedProfiles(provider).length;
    for (const action of ["add", "manage", "history"]) $(`${prefix}-account-${action}`).disabled = busy;
  }
  const profiles = scopedProfiles(), identities = scopedIdentities();
  const switchValid = profiles.some((p) => profileValue(p) === $("account-switch-profile").value);
  const manageValid = profiles.some((p) => profileValue(p) === $("account-manage-profile").value);
  $("account-switch-profile").disabled = busy || !profiles.length;
  $("account-manage-profile").disabled = busy || !profiles.length;
  $("account-switch-confirm").disabled = busy || !switchValid;
  $("account-delete").disabled = busy || !manageValid || selectedProfileIsCurrent();
  $("account-note-target").disabled = busy || !identities.length;
  $("account-note-submit").disabled = busy || !identities.some((a) => a.id === $("account-note-target").value);
  const resetValue = $("account-reset-profile").value;
  const resetValid = latest?.currentAccounts !== undefined ? identities.some((a) => a.id === resetValue) : profiles.some((p) => p.name === resetValue);
  $("account-reset-profile").disabled = busy || !$("account-reset-profile").options.length;
  $("account-reset-usage").disabled = busy || !resetValid;
}
function syncChoices(select, choices) {
  const previous = select.value;
  if (select.options.length === choices.length && choices.every(([text, value], i) => select.options[i]?.value === value && select.options[i]?.textContent === text)) return;
  select.replaceChildren(...choices.map(([text, value]) => new Option(text, value)));
  select.value = choices.some(([, value]) => value === previous) ? previous : choices[0]?.[1] ?? "";
}
function syncNote() {
  $("account-note").value = latest?.accounts?.find((a) => a.id === $("account-note-target").value)?.note ?? "";
  delete $("account-note").dataset.dirty;
}
function openAccountDialog(action, menu) {
  const card = ACCOUNT_CARDS.find(([, provider]) => provider === menu.dataset.provider);
  if (busy || !latest || !card || !["switch", "add", "manage", "history"].includes(action)) return;
  if (managedProvider !== card[1]) {
    managedProvider = card[1];
    delete $("account-note").dataset.dirty;
    for (const id of ["account-name", "account-import-name", "account-import-path", "account-note"]) $(id).value = "";
    for (const id of ["account-switch-profile", "account-manage-profile", "account-reset-profile", "account-note-target"]) $(id).replaceChildren();
    for (const id of ["account-add-feedback", "account-switch-feedback", "account-manage-feedback", "history-feedback"]) $(id).textContent = "";
  }
  for (const [kind, title] of [["switch", "切换账号"], ["add", "新增账号"], ["manage", "管理账号"], ["history", "历史与备份"]]) {
    $(`account-${kind}-title`).textContent = `${card[2]} · ${title}`;
  }
  $("account-login-command").textContent = `/login ${managedProvider}`;
  renderAccountControls();
  const opener = menu.querySelector("summary"), dialog = $(`account-${action}-dialog`);
  menu.open = false;
  opener.focus(); // Native dialog close/Escape returns to a visible control, not a closed menu item.
  dialogOpeners.set(dialog, opener);
  dialog.showModal();
}
const accountMenus = [...document.querySelectorAll(".account-menu")];
for (const menu of accountMenus) {
  menu.querySelector("summary").addEventListener("click", () => { for (const other of accountMenus) if (other !== menu) other.open = false; });
  for (const button of menu.querySelectorAll("[data-account-action]")) {
    button.addEventListener("click", () => { openAccountDialog(button.dataset.accountAction, menu); });
  }
}
document.addEventListener("click", (event) => { for (const menu of accountMenus) if (!menu.contains(event.target)) menu.open = false; });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of accountMenus) {
    if (menu.open && menu.contains(document.activeElement)) menu.querySelector("summary").focus();
    menu.open = false;
  }
});
for (const dialog of document.querySelectorAll('dialog[id^="account-"]')) {
  dialog.addEventListener("close", () => {
    const opener = dialogOpeners.get(dialog);
    if (opener) (opener.closest(".provider-card").hidden ? $("settings").querySelector("summary") : opener).focus();
  });
}
for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => { $(button.dataset.closeDialog).close(); });
}
$("account-save-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("account-name").value.trim();
  if (!name || profileName(name)) void queueAccountCommand("save", `${managedProvider}${name ? ` ${name}` : ""}`, "account-add-feedback", "account-add-dialog");
});
$("account-import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("account-import-name").value.trim();
  const path = $("account-import-path").value.trim();
  if (!profileName(name) || !path || /[\r\n\u0000]/.test(path)) {
    $("account-add-feedback").textContent = "名称或 Pi 机器上的 JSON 路径无效。";
    return;
  }
  void queueAccountCommand("import", `${managedProvider} ${name} ${path}`, "account-add-feedback", "account-add-dialog");
});
$("account-switch-confirm").addEventListener("click", () => {
  const args = profileArgs($("account-switch-profile").value);
  if (args && confirm(`切换到 ${args}？Pi 中还会要求确认；不会切换模型或重建会话。`)) {
    void queueAccountCommand("use", args, "account-switch-feedback", "account-switch-dialog");
  }
});
$("account-switch-profile").addEventListener("change", updateAccountButtons);
$("account-manage-profile").addEventListener("change", updateAccountButtons);
$("account-delete").addEventListener("click", () => {
  const args = profileArgs($("account-manage-profile").value);
  if (args && confirm(`备份后删除 ${args} 的保存凭据？历史账号和用量仍保留。`)) void queueAccountCommand("delete", args, "account-manage-feedback", "account-manage-dialog");
});
$("account-reset-usage").addEventListener("click", () => {
  const value = $("account-reset-profile").value;
  const known = latest.currentAccounts !== undefined ? scopedIdentities().some((a) => a.id === value) : scopedProfiles().some((p) => p.name === value);
  if (known && (profileName(value) || /^account:[a-f0-9]{64}$/.test(value)) && confirm("先备份，再清除此账号的本地用量？不影响其他账号或服务商实际额度。")) void queueAccountCommand("reset-usage", `${managedProvider} ${value}`, "history-feedback");
});
$("account-reset-profile").addEventListener("change", updateAccountButtons);
$("account-note-target").addEventListener("change", () => { syncNote(); updateAccountButtons(); });
$("account-note").addEventListener("input", () => { $("account-note").dataset.dirty = "true"; });
$("account-note-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("account-note-target").value, note = $("account-note").value.trim();
  if (scopedIdentities().some((a) => a.id === id) && /^account:[a-f0-9]{64}$/.test(id) && note.length <= 120 && !/[\r\n\u0000]/.test(note)) {
    delete $("account-note").dataset.dirty;
    void queueAccountCommand("note", `${managedProvider} ${id}${note ? ` ${note}` : ""}`, "account-manage-feedback");
  }
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
  void load();
});
$("quota-view").addEventListener("change", (event) => {
  const view = event.currentTarget.value;
  $("provider-grid").dataset.quotaView = view;
  $("quota-pie-legend").hidden = view !== "pie";
});
$("chart-view").addEventListener("change", renderChart);
$("chart-period").addEventListener("change", renderChart);
$("chart-model").addEventListener("change", renderChart);
$("model-comparison-metric").addEventListener("change", renderModelComparison);
$("model-comparison-period").addEventListener("change", renderModelComparison);
$("interval-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Number($("interval").value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) return;
  void action("/api/interval", { seconds });
});
$("show-oai").addEventListener("change", (event) => {
  void action("/api/statusbar", { showOaiInStatusbar: event.currentTarget.checked });
});
$("show-claude").addEventListener("change", (event) => {
  void action("/api/statusbar", { showClaudeInStatusbar: event.currentTarget.checked });
});
$("show-agy").addEventListener("change", (event) => {
  void action("/api/statusbar", { showAgyInStatusbar: event.currentTarget.checked });
});
$("show-grok").addEventListener("change", (event) => {
  void action("/api/statusbar", { showGrokInStatusbar: event.currentTarget.checked });
});
for (const [prefix, key] of CARD_SETTINGS) {
  $(`show-${prefix}-card`).addEventListener("change", (event) => {
    void action("/api/cards", { [key]: event.currentTarget.checked });
  });
}
if (typeof ResizeObserver !== "undefined") {
  let chartWidth;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === chartWidth) return;
    chartWidth = entry.contentRect.width;
    renderChart();
  }).observe($("chart"));
}
function startTimers() {
  if (document.hidden) return;
  if (pollTimer === undefined) pollTimer = setInterval(() => { if (!busy) void load(); }, 5000);
  if (countdownTimer === undefined) countdownTimer = setInterval(renderCountdown, 1000);
}
function stopTimers() {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  if (countdownTimer !== undefined) clearInterval(countdownTimer);
  pollTimer = undefined;
  countdownTimer = undefined;
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTimers();
  else if (pollTimer === undefined) {
    void load();
    startTimers();
  }
});
void load();
startTimers();
