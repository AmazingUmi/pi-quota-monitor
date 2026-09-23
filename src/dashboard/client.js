"use strict";

const $ = (id) => document.getElementById(id);
let latest;
let control;
let busy = false;

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
function groupWindow(usage, kind) {
  if (!usage) return undefined;
  const matches = kind === "gemini" ? /gemini/i : /claude|gpt|shared/i;
  const windows = (usage.groups ?? []).filter((group) => matches.test(group.name))
    .flatMap((group) => group.windows ?? []);
  if (windows.length) return windows.reduce((a, b) => a.remainingPercent <= b.remainingPercent ? a : b);
  const models = (usage.models ?? []).filter((model) => matches.test(`${model.modelId} ${model.displayName ?? ""}`) && typeof model.remainingPercent === "number");
  if (!models.length) return undefined;
  const model = models.reduce((a, b) => a.remainingPercent <= b.remainingPercent ? a : b);
  return { remainingPercent: model.remainingPercent, resetAt: model.resetAt };
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
function title(parent, value) {
  const el = document.createElement("h3");
  el.className = "section-title";
  el.textContent = value;
  parent.append(el);
}
function notice(parent, value) {
  if (!value) return;
  const el = document.createElement("p");
  el.className = "notice";
  el.textContent = value;
  parent.append(el);
}
function card(id, window) {
  $(id).textContent = percent(window?.remainingPercent);
  $(`${id}-reset`).textContent = window ? countdown(window.resetAt) : "暂无额度数据";
}
function render() {
  if (!latest) return;
  const codex = latest.codex;
  const agy = latest.antigravity;
  card("codex-five", codex.value?.fiveHour);
  card("codex-week", codex.value?.weekly);
  card("agy-gemini", groupWindow(agy.value, "gemini"));
  card("agy-shared", groupWindow(agy.value, "shared"));
  const providers = $("providers");
  providers.replaceChildren();
  title(providers, `OpenAI Codex${codex.value?.plan ? ` · ${codex.value.plan}` : ""}`);
  row(providers, "5 小时", percent(codex.value?.fiveHour?.remainingPercent));
  row(providers, "每周", percent(codex.value?.weekly?.remainingPercent));
  if (codex.value?.capturedAt) row(providers, "最近成功查询", new Date(codex.value.capturedAt).toLocaleString());
  notice(providers, codex.error ? `Codex：${codex.error}（保留上次成功结果）` : "");
  title(providers, `Antigravity${agy.value?.plan ? ` · ${agy.value.plan}` : ""}`);
  for (const group of (agy.value?.groups ?? [])) {
    for (const window of group.windows) row(providers, `${group.name} · ${window.label}`, `${percent(window.remainingPercent)} · ${countdown(window.resetAt)}`);
  }
  if (!(agy.value?.groups?.length)) {
    row(providers, "Gemini", percent(groupWindow(agy.value, "gemini")?.remainingPercent));
    row(providers, "Claude/GPT", percent(groupWindow(agy.value, "shared")?.remainingPercent));
  }
  if (agy.value?.capturedAt) row(providers, "最近成功查询", new Date(agy.value.capturedAt).toLocaleString());
  notice(providers, agy.value?.summaryError);
  notice(providers, agy.error ? `Antigravity：${agy.error}（保留上次成功结果）` : "");
  const tokens = $("tokens");
  tokens.replaceChildren();
  for (const [name, value] of [["当前会话", latest.session], ["今日", latest.daily]]) {
    title(tokens, name);
    for (const [label, key] of [["Input", "input"], ["Output", "output"], ["Reasoning", "reasoning"], ["Cache read", "cacheRead"], ["Cache write", "cacheWrite"], ["Total", "totalTokens"]]) {
      row(tokens, label, Number(value?.[key] ?? 0).toLocaleString());
    }
  }
  if (document.activeElement !== $("interval")) $("interval").value = String(latest.config.refreshIntervalSeconds);
  $("last-check").textContent = `本地状态更新：${new Date(latest.updatedAt).toLocaleTimeString()}`;
}
async function load() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("本地会话已结束，请在 Pi 中重新运行 /quota console");
  const state = await response.json();
  control = state.control;
  latest = state;
  render();
}
async function action(path, body) {
  if (busy || !control) return;
  busy = true;
  $("refresh").disabled = true;
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
    $("feedback").textContent = error.message || "操作失败";
  } finally {
    $("refresh").disabled = false;
    busy = false;
  }
}
$("refresh").addEventListener("click", () => { void action("/api/refresh"); });
$("interval-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Number($("interval").value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) return;
  void action("/api/interval", { seconds });
});
void load().catch((error) => { $("feedback").textContent = error.message; });
setInterval(() => { void load().catch((error) => { $("feedback").textContent = error.message; }); }, 5000);
setInterval(render, 1000);
