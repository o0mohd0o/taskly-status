// Taskly status page. Static; reads status.json written by the monitor
// workflow to the `data` branch. All data-derived text goes through
// textContent / createTextNode — incident bodies are user-authored.

const params = new URLSearchParams(location.search);
const DATA_URL = params.get("data") ||
  "https://raw.githubusercontent.com/o0mohd0o/taskly-status/data/status.json";
if (["light", "dark"].includes(params.get("theme"))) document.documentElement.dataset.theme = params.get("theme");
const REFRESH_MS = 60_000;
const STALE_MIN = 20;
const DAY = 864e5;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const ICONS = {
  good: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.86-9.86a.75.75 0 0 0-1.22-.88l-3.24 4.5-1.6-1.6a.75.75 0 1 0-1.06 1.06l2.22 2.22a.75.75 0 0 0 1.14-.09l3.76-5.21Z" clip-rule="evenodd"/></svg>',
  warning: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.48 2.88a1.75 1.75 0 0 1 3.04 0l6.28 11.02A1.75 1.75 0 0 1 16.28 16.5H3.72a1.75 1.75 0 0 1-1.52-2.6L8.48 2.88ZM10 6.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6.5Zm0 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>',
  critical: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM7.28 6.22a.75.75 0 0 0-1.06 1.06L8.94 10l-2.72 2.72a.75.75 0 1 0 1.06 1.06L10 11.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L11.06 10l2.72-2.72a.75.75 0 0 0-1.06-1.06L10 8.94 7.28 6.22Z" clip-rule="evenodd"/></svg>',
  maintenance: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-12a.75.75 0 0 0-1.5 0v4c0 .2.08.39.22.53l2.5 2.5a.75.75 0 1 0 1.06-1.06l-2.28-2.28V6Z" clip-rule="evenodd"/></svg>',
};
ICONS.serious = ICONS.warning;
const COMP_STATUS = {
  up: { tone: "good", label: "Operational" },
  degraded: { tone: "warning", label: "Degraded performance" },
  down: { tone: "critical", label: "Outage" },
};

// -------------------------------------------------------------- helpers ----
const fmtPct = (v) => v == null ? "—" : v >= 99.995 ? "100%" : `${(Math.floor(v * 100) / 100).toFixed(2)}%`;
const fmtMs = (v) => v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
const dayKey = (d) => d.toISOString().slice(0, 10);
const fmtDay = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h > 1 ? "s" : ""} ago` : `${Math.round(h / 24)} days ago`;
}
function duration(a, b) {
  const m = Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function dayTone(d) {
  if (!d || !d.n) return "none";
  const up = (d.up / d.n) * 100;
  if (up >= 99.99) return d.deg / d.n > 0.25 ? "warning" : "good";
  if (up >= 99) return "warning";
  if (up >= 95) return "serious";
  return "critical";
}
function uptimeDays(days, n) {
  let tot = 0, up = 0;
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = days?.[dayKey(new Date(today - i * DAY))];
    if (d) { tot += d.n; up += d.up; }
  }
  return tot ? (up / tot) * 100 : null;
}
function recentStats(rec, hours) {
  const cut = Date.now() / 1000 - hours * 3600;
  const pts = (rec || []).filter(([t]) => t >= cut);
  if (!pts.length) return { uptime: null, avg: null, p95: null };
  const ok = pts.filter(([, , s]) => s !== "d");
  const ms = ok.map(([, m]) => m).sort((a, b) => a - b);
  return {
    uptime: (ok.length / pts.length) * 100,
    avg: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
    p95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null,
  };
}
// Minimal, safe rich text: paragraphs + **bold**. Never innerHTML.
function richText(body) {
  const frag = document.createDocumentFragment();
  for (const para of body.split(/\n{2,}/)) {
    const text = para.trim().replace(/^_(.*)_$/s, "$1");
    if (!text) continue;
    const p = el("p");
    let last = 0;
    for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) {
      p.append(document.createTextNode(text.slice(last, m.index)), el("strong", null, m[1]));
      last = m.index + m[0].length;
    }
    p.append(document.createTextNode(text.slice(last)));
    frag.append(p);
  }
  return frag;
}

// -------------------------------------------------------------- tooltip ----
const tip = $("#tooltip");
function showTip(x, y, build) {
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x - r.width / 2, top = y - r.height - 12;
  left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
  if (top < 8) top = y + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };
addEventListener("scroll", hideTip, { passive: true });

// --------------------------------------------------------------- render ----
let state = null;
let selected = null;

function overall(data) {
  const cur = data.current || {};
  const down = data.components.filter((c) => cur[c.id]?.s === "down");
  const deg = data.components.filter((c) => cur[c.id]?.s === "degraded");
  if (down.length >= 2 || down.some((c) => c.id === "api" || c.id === "web"))
    return { tone: "critical", title: "Major outage", sub: `${down.map((c) => c.name).join(", ")} ${down.length > 1 ? "are" : "is"} unavailable.` };
  if (down.length) return { tone: "serious", title: "Partial outage", sub: `${down[0].name} is unavailable. Everything else is working.` };
  if (deg.length) return { tone: "warning", title: "Degraded performance", sub: `${deg.map((c) => c.name).join(", ")} ${deg.length > 1 ? "are" : "is"} responding slowly.` };
  return { tone: "good", title: "All systems operational", sub: "" };
}

function renderBanner(data) {
  const o = overall(data);
  const b = $("#banner");
  b.className = `banner s-${o.tone}`;
  b.querySelector(".banner-icon").innerHTML = ICONS[o.tone]; // static markup only
  $("#banner-title").textContent = o.title;
  const stale = (Date.now() - new Date(data.generated_at)) / 60000 > STALE_MIN;
  $("#banner-sub").textContent = stale
    ? `Status data is delayed — last check ${ago(data.generated_at)}.`
    : o.sub || `Last checked ${ago(data.generated_at)}.`;
  document.title = o.tone === "good" ? "Taskly Status" : `${o.title} · Taskly Status`;
}

function incidentCard(inc, { compact = false } = {}) {
  const card = el("article", `incident i-${inc.impact}`);
  const h = el("h3");
  const a = el("a", null, inc.title);
  a.href = inc.url;
  h.append(a);
  card.append(h);
  const comps = inc.components.map((id) => state.components.find((c) => c.id === id)?.name || id);
  const meta = inc.state === "open"
    ? `${inc.impact === "maintenance" ? "Maintenance in progress" : "Ongoing"} · started ${fmtDateTime(inc.created_at)}`
    : `Resolved · lasted ${duration(inc.created_at, inc.closed_at)}`;
  card.append(el("p", "inc-meta", comps.length ? `${meta} · Affects ${comps.join(", ")}` : meta));
  const ul = el("ul", "updates");
  const ups = [...inc.updates].reverse();
  for (const u of compact ? ups.slice(0, 3) : ups) {
    const li = el("li");
    const t = el("time", null, fmtDateTime(u.at));
    t.dateTime = u.at;
    li.append(t, richText(u.body));
    ul.append(li);
  }
  card.append(ul);
  return card;
}

function renderActive(data) {
  const box = $("#active");
  const open = data.incidents.filter((i) => i.state === "open");
  box.replaceChildren(...open.map((i) => incidentCard(i)));
  box.hidden = !open.length;
}

function barCount() {
  const w = innerWidth;
  return w < 520 ? 30 : w < 760 ? 60 : 90;
}

function incidentsOn(key, compId) {
  const start = new Date(`${key}T00:00:00Z`), end = new Date(start.getTime() + DAY);
  return state.incidents.filter((i) =>
    (!compId || !i.components.length || i.components.includes(compId)) &&
    new Date(i.created_at) < end && (i.closed_at ? new Date(i.closed_at) : new Date()) >= start);
}

function renderComponents(data) {
  const n = barCount();
  $("#range-label").textContent = `Uptime over the past ${n} days`;
  const list = $("#components");
  list.replaceChildren();
  const today = new Date();
  for (const c of data.components) {
    const cur = data.current?.[c.id];
    const st = COMP_STATUS[cur?.s] || { tone: "none", label: "No data" };
    const li = el("li", "comp");
    const row = el("div", "comp-row");
    const left = el("div");
    left.append(el("div", "comp-name", c.name), el("div", "comp-desc", c.description));
    const pill = el("span", `pill s-${st.tone}`);
    pill.innerHTML = ICONS[st.tone] || ""; // static markup only
    pill.append(document.createTextNode(st.label));
    row.append(left, pill);

    const bars = el("div", "bars");
    bars.setAttribute("role", "img");
    const up = uptimeDays(data.days?.[c.id], n);
    bars.setAttribute("aria-label", `${c.name}: ${fmtPct(up)} uptime over ${n} days`);
    for (let i = n - 1; i >= 0; i--) {
      const key = dayKey(new Date(today - i * DAY));
      const d = data.days?.[c.id]?.[key];
      const tone = dayTone(d);
      const bar = el("div", `bar s-${tone}`);
      const onHover = (ev) => {
        const r = bar.getBoundingClientRect();
        showTip(r.left + r.width / 2, r.top, (t) => {
          t.append(el("div", "tt-label", fmtDay(key)));
          if (!d) { t.append(el("div", "tt-value", "No data")); return; }
          t.append(el("div", "tt-value", `${fmtPct((d.up / d.n) * 100)} uptime`));
          const down = d.n - d.up;
          t.append(el("div", "tt-label", down ? `${down} failed check${down > 1 ? "s" : ""} of ${d.n} (~${down * 5} min)` : `${d.n} checks, all passed`));
          if (d.up) t.append(el("div", "tt-label", `Avg response ${fmtMs(d.ms / d.up)}`));
          for (const inc of incidentsOn(key, c.id)) t.append(el("div", "tt-inc", inc.title));
        });
      };
      bar.addEventListener("pointerenter", onHover);
      bar.addEventListener("pointerleave", hideTip);
      bars.append(bar);
    }
    const foot = el("div", "bar-foot");
    foot.append(el("span", null, `${n} days ago`), el("span", "rule"), el("span", "uptime", up == null ? "No data yet" : `${fmtPct(up)} uptime`), el("span", "rule"), el("span", null, "Today"));
    li.append(row, bars, foot);
    list.append(li);
  }
}

function renderTabs(data) {
  const tabs = $("#latency-tabs");
  if (!selected || !data.components.some((c) => c.id === selected)) selected = data.components[0]?.id;
  tabs.replaceChildren(...data.components.map((c) => {
    const b = el("button", "tab", c.name);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(c.id === selected));
    b.addEventListener("click", () => { selected = c.id; renderTabs(state); renderLatency(state); });
    return b;
  }));
}

function niceMax(v) {
  const steps = [100, 200, 250, 500, 1000, 1500, 2000, 2500, 5000, 10000, 20000];
  return steps.find((s) => s >= v) || Math.ceil(v / 10000) * 10000;
}

function renderLatency(data) {
  const rec = (data.recent?.[selected] || []).filter(([t]) => t * 1000 >= Date.now() - DAY);
  const s = recentStats(rec, 24);
  const last = rec.at(-1);
  const stats = $("#latency-stats");
  stats.replaceChildren();
  for (const [label, value] of [["Now", last ? (last[2] === "d" ? "No response" : fmtMs(last[1])) : "—"], ["Average", fmtMs(s.avg)], ["95th percentile", fmtMs(s.p95)], ["Uptime (24h)", fmtPct(s.uptime)]]) {
    const d = el("div");
    d.append(el("div", "stat-label", label), el("div", "stat-value", value));
    stats.append(d);
  }

  const box = $("#latency-chart");
  const W = Math.max(280, box.clientWidth - 24), H = 200;
  const m = { l: 52, r: 8, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `Response time for the past 24 hours: average ${fmtMs(s.avg)}, 95th percentile ${fmtMs(s.p95)}` });
  box.replaceChildren(svg);
  const t1 = Date.now(), t0 = t1 - DAY;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const okMs = rec.filter((p) => p[1] != null).map((p) => p[1]);
  if (!rec.length) {
    svg.append(Object.assign(svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "empty" }), { textContent: "Collecting data — check back in a few minutes" }));
    return;
  }
  const yMax = niceMax(Math.max(200, ...okMs) * 1.1);
  const y = (v) => m.t + ih - (v / yMax) * ih;

  const grid = svgEl("g", { class: "grid" });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i, yy = y(v);
    grid.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    const lab = svgEl("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end" });
    lab.textContent = v >= 1000 ? `${v / 1000}s` : `${v}ms`;
    grid.append(lab);
  }
  svg.append(grid);
  const axis = svgEl("g", { class: "axis" });
  for (let h = 0; h <= 24; h += 6) {
    const t = t0 + h * 3600e3;
    const lab = svgEl("text", { x: x(t), y: H - 6, "text-anchor": h === 0 ? "start" : h === 24 ? "end" : "middle" });
    lab.textContent = h === 24 ? "Now" : fmtTime(t);
    axis.append(lab);
  }
  svg.append(axis);

  // Line + area, broken where a check failed.
  let d = "", area = "", seg = [];
  const flush = () => {
    if (!seg.length) return;
    d += seg.map((p, i) => `${i ? "L" : "M"}${x(p[0] * 1000).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    area += `M${x(seg[0][0] * 1000).toFixed(1)},${y(0)}` + seg.map((p) => `L${x(p[0] * 1000).toFixed(1)},${y(p[1]).toFixed(1)}`).join("") + `L${x(seg.at(-1)[0] * 1000).toFixed(1)},${y(0)}Z`;
    seg = [];
  };
  for (const p of rec) { if (p[1] == null) flush(); else seg.push(p); }
  flush();
  svg.append(svgEl("path", { d: area, class: "area" }), svgEl("path", { d, class: "line" }));
  for (const p of rec) if (p[2] === "d") svg.append(svgEl("rect", { x: x(p[0] * 1000) - 1.5, y: y(0) - 6, width: 3, height: 6, rx: 1, class: "downtick" }));

  // Crosshair + tooltip (pointer and keyboard).
  const xh = svgEl("line", { class: "xhair", y1: m.t, y2: m.t + ih, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, class: "dot", visibility: "hidden" });
  svg.append(xh, dot);
  let idx = rec.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(rec.length - 1, i));
    const p = rec[idx], px = x(p[0] * 1000);
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.setAttribute("visibility", "visible");
    if (p[1] != null) { dot.setAttribute("cx", px); dot.setAttribute("cy", y(p[1])); dot.setAttribute("visibility", "visible"); }
    else dot.setAttribute("visibility", "hidden");
    const r = svg.getBoundingClientRect(), scale = r.width / W;
    showTip(r.left + px * scale, r.top + (p[1] != null ? y(p[1]) : y(0)) * scale, (t) => {
      const row = el("div", "tt-row");
      row.append(el("span", "tt-key"), el("span", "tt-value", p[2] === "d" ? "No response" : fmtMs(p[1])));
      t.append(row, el("div", "tt-label", `${fmtTime(p[0] * 1000)}${p[2] === "g" ? " · slow" : ""}`));
    });
  };
  const hide = () => { xh.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); };
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const t = t0 + (((ev.clientX - r.left) * (W / r.width) - m.l) / iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < rec.length; i++) if (Math.abs(rec[i][0] * 1000 - t) < Math.abs(rec[best][0] * 1000 - t)) best = i;
    show(best);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(idx));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") { show(idx - 1); ev.preventDefault(); }
    if (ev.key === "ArrowRight") { show(idx + 1); ev.preventDefault(); }
  });
}

function renderTable(data) {
  const tb = $("#uptime-table tbody");
  tb.replaceChildren(...data.components.map((c) => {
    const tr = el("tr");
    const r = recentStats(data.recent?.[c.id], 24);
    const cells = [c.name, fmtPct(r.uptime), fmtPct(uptimeDays(data.days?.[c.id], 7)), fmtPct(uptimeDays(data.days?.[c.id], 30)), fmtPct(uptimeDays(data.days?.[c.id], 90)), fmtMs(r.avg)];
    cells.forEach((v, i) => tr.append(el(i ? "td" : "th", null, v)));
    tr.firstChild.setAttribute("scope", "row");
    return tr;
  }));
}

function renderPast(data) {
  const box = $("#past");
  box.replaceChildren();
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const key = dayKey(new Date(today - i * DAY));
    const day = el("div", "day");
    day.append(el("h3", null, fmtDay(key)));
    const incs = data.incidents.filter((inc) => dayKey(new Date(inc.created_at)) === key);
    if (!incs.length) day.append(el("p", "none", "No incidents reported."));
    else for (const inc of incs) day.append(incidentCard(inc, { compact: true }));
    box.append(day);
  }
}

function renderAll() {
  if (!state) return;
  renderBanner(state);
  renderActive(state);
  renderComponents(state);
  renderTabs(state);
  renderLatency(state);
  renderTable(state);
  renderPast(state);
  const u = $("#updated");
  u.textContent = `Last checked ${ago(state.generated_at)} · refreshes automatically`;
}

async function load() {
  try {
    const res = await fetch(`${DATA_URL}${DATA_URL.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = await res.json();
    state.incidents ||= [];
    renderAll();
  } catch (e) {
    if (!state) {
      $("#banner").className = "banner";
      $("#banner-title").textContent = "Status data unavailable";
      $("#banner-sub").textContent = "We couldn't load the latest checks. Try again in a minute.";
    }
    console.warn("status load failed", e);
  }
}

let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(renderAll, 150); });
load();
setInterval(load, REFRESH_MS);
