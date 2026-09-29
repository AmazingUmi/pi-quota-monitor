"use strict";
// Design layer for the dashboard. Loaded after client.js; wraps a few of its globals, never replaces its data logic.
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  // 1. Smooth trend curves (monotone cubic: never overshoots below zero).
  function curve(p) {
    const n = p.length, dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${p[0][0]} ${p[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${p[i][0] + h} ${p[i][1] + t[i] * h} ${p[i + 1][0] - h} ${p[i + 1][1] - t[i + 1] * h} ${p[i + 1][0]} ${p[i + 1][1]}`;
    }
    return d;
  }
  const baseTrend = renderTrend;
  renderTrend = function (field, chartId, summaryId) {
    baseTrend(field, chartId, summaryId);
    const svg = document.querySelector(`#${chartId} svg`);
    const line = svg?.querySelector(".chart-line"), area = svg?.querySelector(".chart-area");
    if (!line || !area) return;
    const pts = [...svg.querySelectorAll(".chart-point")].map((c) => [+c.getAttribute("cx"), +c.getAttribute("cy")]);
    const base = /L\S+ (\S+) L\S+ \S+ Z$/.exec(area.getAttribute("d"));
    if (pts.length < 3 || !base) return;
    const d = curve(pts);
    line.setAttribute("d", d);
    area.setAttribute("d", `${d} L${pts[n(pts)][0]} ${base[1]} L${pts[0][0]} ${base[1]} Z`);
  };
  const n = (a) => a.length - 1;

  // 2. Concentric gauge: outer ring = first window, inner ring = second window.
  const nice = (t) => /weekly/i.test(t) ? "每周" : /\b5H\b/i.test(t) ? "5 小时" : t.replace(/ Limit Remaining$/i, "");
  function gauge(box) {
    const wins = [...box.children].filter((c) => c.classList.contains("quota-window"));
    if (!wins.length || box.querySelector(":scope > .gauge")) return;
    const info = wins.map((w) => {
      const m = w.querySelector("meter");
      return { label: nice(w.querySelector(".label")?.textContent ?? ""), num: w.querySelector("strong")?.textContent ?? "—",
        unit: w.querySelector(".quota-unit")?.textContent ?? "", known: !!m && !m.hidden, v: m ? m.value : 0, level: m?.dataset.level ?? "normal",
        reset: w.querySelector("small.subtle"), help: w.querySelector("details.quota-money"), extras: [...w.children].filter((c) => c.matches(".quota-money-values,.quota-estimate-value")) };
    });
    const svg = sv("svg", { class: "gauge-ring", viewBox: "0 0 136 136", role: "img",
      "aria-label": info.slice(0, 2).map((i) => `${i.label}：${i.known ? `${i.num} ${i.unit}` : i.unit}`).join("；") });
    [56, 41].slice(0, info.length).forEach((r, i) => {
      svg.append(sv("circle", { cx: 68, cy: 68, r, class: "gauge-track" }));
      if (info[i].known && info[i].v > 0) {
        const c = 2 * Math.PI * r;
        svg.append(sv("circle", { cx: 68, cy: 68, r, class: "gauge-value", "data-level": info[i].level,
          "stroke-dasharray": `${(c * Math.max(info[i].v, 0.5)) / 100} ${c}`, transform: "rotate(-90 68 68)" }));
      }
    });
    const center = sv("text", { x: 68, y: 75, "text-anchor": "middle", class: "gauge-num" });
    center.textContent = info[0].known ? info[0].num : "—";
    svg.append(center);
    const legend = el("div", "gauge-legend");
    info.forEach((i, idx) => {
      const row = el("div", "gauge-row");
      row.dataset.ring = String(idx);
      const head = el("div", "gauge-head");
      head.append(el("span", "gauge-dot"), el("span", "", i.label));
      if (i.help) head.append(i.help);
      const val = el("div", "gauge-val", i.known ? i.num : "—");
      val.append(el("small", "", i.unit));
      row.append(head, val);
      if (i.reset) row.append(i.reset);
      row.append(...i.extras);
      legend.append(row);
    });
    const parts = [el("div", "gauge")];
    parts[0].append(svg, legend);
    box.replaceChildren(...parts);
  }
  const baseUpdate = updateQuotaContent;
  updateQuotaContent = function (container, data, scope, build) {
    // Transform inside the build so the base renderer restores disclosure focus
    // after the help controls have reached their final position.
    baseUpdate(container, data, scope, () => {
      build();
      [container, ...container.querySelectorAll(".quota-windows")].filter((b) => b.classList.contains("quota-windows")).forEach(gauge);
    });
  };
  // The first state response may arrive before this deferred script finishes loading.
  document.querySelectorAll(".quota-windows").forEach(gauge);

  // 3. Segmented controls that drive the original <select> elements.
  function segment(select) {
    if (!select || select.dataset.seg) return;
    select.dataset.seg = "1";
    const group = el("div", "seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", select.labels?.[0]?.textContent ?? "");
    const sync = () => group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === select.value)));
    for (const option of select.options) {
      const b = el("button", "", option.textContent);
      b.type = "button"; b.dataset.v = option.value; b.setAttribute("role", "radio");
      b.addEventListener("click", () => {
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
      });
      group.append(b);
    }
    select.hidden = true;
    select.after(group);
    sync();
  }
  for (const id of ["chart-view", "chart-period", "codex-period-kind", "model-comparison-metric", "model-comparison-period"]) segment(document.getElementById(id));

  // 4. One trend chart at a time: Token or cost.
  const grid = document.querySelector(".trend-grid"), controls = document.querySelector(".usage-panel .chart-controls");
  if (grid && controls) {
    grid.dataset.metric = "tokens";
    const group = el("div", "seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "趋势指标");
    for (const [key, text] of [["tokens", "Token"], ["cost", "金额"]]) {
      const b = el("button", "", text);
      b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(key === "tokens"));
      b.addEventListener("click", () => {
        grid.dataset.metric = key;
        group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        requestAnimationFrame(() => { if (typeof latest !== "undefined" && latest) renderChart(); });
      });
      group.append(b);
    }
    controls.prepend(group);
  }

  // 5. Glass strength slider (remembered per browser).
  const slider = document.getElementById("glass");
  const applyGlass = (s) => {
    const style = document.documentElement.style;
    style.setProperty("--ga", (0.94 - 0.68 * s / 100).toFixed(3));
    style.setProperty("--gb", (32 * s / 100).toFixed(1));
  };
  let level = 65;
  try {
    const saved = localStorage.getItem("pq-glass-strength");
    const legacy = localStorage.getItem("pq-glass");
    if (saved !== null && saved !== "" && Number.isFinite(+saved)) level = Math.min(100, Math.max(0, +saved));
    else if (legacy !== null && legacy !== "" && Number.isFinite(+legacy)) {
      // The old slider measured opacity; invert it to preserve the saved appearance.
      level = 100 - Math.min(100, Math.max(0, +legacy));
      localStorage.setItem("pq-glass-strength", String(level));
    }
  } catch { /* storage unavailable */ }
  applyGlass(level);
  if (slider) {
    slider.value = String(level);
    slider.addEventListener("input", () => {
      applyGlass(+slider.value);
      try { localStorage.setItem("pq-glass-strength", slider.value); } catch { /* storage unavailable */ }
    });
  }

  // 6. Nav follows the section in view.
  const links = [...document.querySelectorAll(".main-nav a")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href"))?.closest("section,details") ?? null);
  const mark = (i) => links.forEach((a, k) => (k === i ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
  mark(0);
  if ("IntersectionObserver" in window) {
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target);
      const i = sections.findIndex((s) => s && seen.has(s));
      if (i >= 0) mark(i);
    }, { rootMargin: "-25% 0px -55% 0px" });
    sections.forEach((s) => s && io.observe(s));
  }

  // 7. Account and ledger share one menu.
  const menu = document.getElementById("account-menu");
  if (menu) {
    document.addEventListener("click", (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary")?.focus(); } });
    menu.querySelectorAll(".account-actions button").forEach((b) => b.addEventListener("click", () => { menu.open = false; }));
    document.getElementById("usage-account")?.addEventListener("change", () => {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
  }
})();
