// Taskly status monitor. Runs on GitHub Actions (Node 20+, no dependencies).
//
//   MODE=probe      probe every component, record history, open/close the
//                   automatic incident, email on transitions, refresh incidents
//   MODE=incidents  only refresh the incident list (issue / comment events)
//
// State lives in DATA_DIR/status.json, which the workflow commits to the
// `data` branch. The status page reads that file from raw.githubusercontent.com.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const env = process.env;
const MODE = env.MODE || "probe";
const DATA_DIR = env.DATA_DIR || join(root, "data");
const DATA_FILE = join(DATA_DIR, "status.json");
const REPO = env.GITHUB_REPOSITORY;
const TOKEN = env.GITHUB_TOKEN;
const RECENT_HOURS = 48;
const HISTORY_DAYS = 90;
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const dayKey = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- state ----
function loadState() {
  if (existsSync(DATA_FILE)) {
    try { return JSON.parse(readFileSync(DATA_FILE, "utf8")); } catch {}
  }
  return { version: 1, current: {}, days: {}, recent: {}, incidents: [] };
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  state.generated_at = new Date().toISOString();
  state.components = config.components.map(({ id, name, description }) => ({ id, name, description }));
  writeFileSync(DATA_FILE, JSON.stringify(state));
}

// ---------------------------------------------------------------- probe ----
async function probeOnce(c) {
  const started = performance.now();
  try {
    const res = await fetch(c.url, {
      headers: { "User-Agent": "taskly-status-monitor", ...(c.headers || {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    const ms = Math.round(performance.now() - started);
    const codeOk = res.status === (c.expect ?? 200);
    const bodyOk = !c.contains || body.includes(c.contains);
    return { ok: codeOk && bodyOk, code: res.status, ms,
      detail: codeOk ? (bodyOk ? "" : "unexpected response body") : `HTTP ${res.status}, expected ${c.expect ?? 200}` };
  } catch (e) {
    return { ok: false, code: 0, ms: null, detail: e.name === "TimeoutError" ? "timed out after 20s" : String(e.cause?.code || e.message) };
  }
}

async function probe(c) {
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await probeOnce(c);
    if (r.ok) break;
    if (attempt < 3) await sleep(15000);
  }
  // A single slow response is usually a cold connection; re-probe once and
  // keep the faster result before calling the component degraded.
  if (r.ok && r.ms > config.degradedMs) {
    const again = await probeOnce(c);
    if (again.ok && again.ms < r.ms) r = again;
  }
  const s = !r.ok ? "down" : r.ms > config.degradedMs ? "degraded" : "up";
  return { ...r, s };
}

// --------------------------------------------------------------- github ----
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function ensureLabels() {
  const want = [
    ["incident", "d03b3b", "Shown on the status page"],
    ["auto", "74747f", "Opened by the monitor"],
    ["major", "d03b3b", "Major outage"],
    ["minor", "fab219", "Partial outage / degraded"],
    ["maintenance", "2a4a7f", "Planned maintenance"],
    ...config.components.map((c) => [`component:${c.id}`, "c8d7ea", c.name]),
  ];
  const have = new Set((await gh(`/repos/${REPO}/labels?per_page=100`)).map((l) => l.name));
  for (const [name, color, description] of want) {
    if (!have.has(name)) await gh(`/repos/${REPO}/labels`, { method: "POST", body: { name, color, description } });
  }
}

async function openAutoIncident() {
  const list = await gh(`/repos/${REPO}/issues?labels=incident,auto&state=open&per_page=5`);
  return list.find((i) => !i.pull_request) || null;
}

const names = (ids) => ids.map((id) => config.components.find((c) => c.id === id)?.name || id);
const stamp = () => now.toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function handleIncident(down) {
  if (!TOKEN) return { change: "none", issue: null }; // local dry run
  await ensureLabels();
  const open = await openAutoIncident();
  const downIds = down.map((d) => d.id);

  if (downIds.length && !open) {
    const major = downIds.length >= 2 || downIds.includes("api") || downIds.includes("web");
    const issue = await gh(`/repos/${REPO}/issues`, {
      method: "POST",
      body: {
        title: `${names(downIds).join(", ")} ${downIds.length > 1 ? "are" : "is"} unavailable`,
        body: `**Investigating** — Our monitoring detected that ${names(downIds).join(", ")} ${downIds.length > 1 ? "are" : "is"} not responding as of ${stamp()}. We're looking into it.\n\n_This incident was opened automatically and will update when service recovers._`,
        labels: ["incident", "auto", major ? "major" : "minor", ...downIds.map((id) => `component:${id}`)],
      },
    });
    // Only maintainers may post updates on a public status incident.
    await gh(`/repos/${REPO}/issues/${issue.number}/lock`, { method: "PUT" }).catch((e) => console.log(`lock failed: ${e.message}`));
    return { change: "down", issue };
  }

  if (downIds.length && open) {
    const have = new Set(open.labels.map((l) => l.name));
    const added = downIds.filter((id) => !have.has(`component:${id}`));
    if (added.length) {
      await gh(`/repos/${REPO}/issues/${open.number}/labels`, { method: "POST", body: { labels: added.map((id) => `component:${id}`) } });
      await gh(`/repos/${REPO}/issues/${open.number}/comments`, { method: "POST",
        body: { body: `**Update** — ${names(added).join(", ")} ${added.length > 1 ? "are" : "is"} also affected (${stamp()}).` } });
    }
    return { change: "none", issue: open };
  }

  if (!downIds.length && open) {
    await gh(`/repos/${REPO}/issues/${open.number}/comments`, { method: "POST",
      body: { body: `**Resolved** — All systems are operating normally again as of ${stamp()}.` } });
    await gh(`/repos/${REPO}/issues/${open.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    return { change: "up", issue: open };
  }
  return { change: "none", issue: null };
}

async function loadIncidents() {
  if (!TOKEN) return [];
  const since = new Date(now.getTime() - HISTORY_DAYS * 864e5).toISOString();
  const issues = (await gh(`/repos/${REPO}/issues?labels=incident&state=all&since=${since}&per_page=50&sort=created&direction=desc`))
    .filter((i) => !i.pull_request && (TRUSTED.has(i.author_association) || i.user?.type === "Bot"));
  const out = [];
  for (const i of issues) {
    const comments = i.comments ? await gh(`/repos/${REPO}/issues/${i.number}/comments?per_page=100`) : [];
    const labels = i.labels.map((l) => l.name);
    out.push({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      created_at: i.created_at,
      closed_at: i.closed_at,
      impact: labels.includes("maintenance") ? "maintenance" : labels.includes("major") ? "major" : "minor",
      components: labels.filter((l) => l.startsWith("component:")).map((l) => l.slice(10)),
      updates: [
        { at: i.created_at, body: i.body || "" },
        ...comments
          .filter((c) => TRUSTED.has(c.author_association) || c.user?.type === "Bot")
          .map((c) => ({ at: c.created_at, body: c.body || "" })),
      ],
    });
  }
  return out;
}

// ---------------------------------------------------------------- email ----
function sendEmail(subject, text) {
  if (!env.SMTP_PASSWORD || !env.ALERT_EMAIL) { console.log("email skipped: SMTP_PASSWORD/ALERT_EMAIL not set"); return; }
  const mail = [
    `From: Taskly Status <${env.SMTP_USER}>`,
    `To: ${env.ALERT_EMAIL}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ].join("\r\n");
  const r = spawnSync("curl", ["-sS", "--fail", "--ssl-reqd", "--url", env.SMTP_URL,
    "--user", `${env.SMTP_USER}:${env.SMTP_PASSWORD}`,
    "--mail-from", env.SMTP_USER, "--mail-rcpt", env.ALERT_EMAIL, "--upload-file", "-"],
    { input: mail, encoding: "utf8" });
  if (r.status !== 0) console.log(`email FAILED: ${r.stderr}`);
  else console.log(`email sent: ${subject} -> ${env.ALERT_EMAIL}`);
}

// ----------------------------------------------------------------- main ----
const state = loadState();

if (MODE === "probe") {
  const results = await Promise.all(config.components.map(async (c) => [c, await probe(c)]));
  const ts = Math.floor(now.getTime() / 1000);
  const cutoffRecent = ts - RECENT_HOURS * 3600;
  const cutoffDay = dayKey(new Date(now.getTime() - (HISTORY_DAYS + 1) * 864e5));
  const today = dayKey(now);

  for (const [c, r] of results) {
    state.current[c.id] = { s: r.s, ms: r.ms, code: r.code, at: now.toISOString() };
    const days = (state.days[c.id] ||= {});
    const d = (days[today] ||= { n: 0, up: 0, deg: 0, ms: 0 });
    d.n++;
    if (r.s !== "down") { d.up++; d.ms += r.ms; }
    if (r.s === "degraded") d.deg++;
    for (const k of Object.keys(days)) if (k < cutoffDay) delete days[k];
    const rec = (state.recent[c.id] ||= []);
    rec.push([ts, r.ms, r.s[0]]);
    state.recent[c.id] = rec.filter(([t]) => t >= cutoffRecent);
    console.log(`${r.s.padEnd(8)} ${c.name} — ${c.url} → ${r.code} ${r.ms ?? "-"}ms ${r.detail}`);
  }

  const down = results.filter(([, r]) => r.s === "down").map(([c, r]) => ({ id: c.id, name: c.name, url: c.url, detail: r.detail }));
  const report = results.map(([c, r]) => `${r.s.toUpperCase().padEnd(9)}${c.name} — ${c.url} → ${r.code || "no response"}${r.ms != null ? ` in ${r.ms}ms` : ""}${r.detail ? ` (${r.detail})` : ""}`).join("\n");
  const pageUrl = env.STATUS_PAGE_URL || "";

  const { change, issue } = await handleIncident(down);
  if (change === "down") {
    sendEmail(`🔴 Taskly DOWN: ${down.map((d) => d.name).join(", ")}`,
      `Production checks are failing (3 attempts, 15s apart).\n\n${report}\n\nPublic incident: ${issue.html_url}\nStatus page: ${pageUrl}\n\nRunbook: ssh to the host, check 'systemctl status pm2-tasklypro' (NRestarts climbing = boot race) and 'pm2 ls' as tasklypro.\nPost public updates by commenting on the incident issue.`);
  } else if (change === "up") {
    sendEmail("🟢 Taskly recovered",
      `All production checks are passing again. The incident was closed automatically.\n\n${report}\n\nIncident: ${issue.html_url}\nStatus page: ${pageUrl}`);
  }
  if (env.TEST_EMAIL === "true") {
    sendEmail("✅ Taskly status monitor test", `Test email: the status monitor can reach you.\n\n${report}\n\nStatus page: ${pageUrl}`);
  }
}

state.incidents = await loadIncidents();
saveState(state);
console.log(`wrote ${DATA_FILE} (${state.incidents.length} incidents)`);
