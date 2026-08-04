/* LocalHarness UI
 *
 * Talks to the local server when one is there, and falls back to a worked
 * demo when it is not. The fallback is not a mockup: equipping really
 * recomputes the budget, and fixing an answer really mines assertions out of
 * the diff, because those two moments are the entire product and a fake
 * version of them would prove nothing.
 */

// ── token estimation (mirrors src/tokens.ts) ──────────────────────────────────

const WORD = /[A-Za-z0-9']+|[^\sA-Za-z0-9']/g;

function estimateTokens(text) {
  if (!text) return 0;
  const pieces = text.match(WORD);
  if (!pieces) return 0;
  let total = 0;
  for (const p of pieces) {
    if (/^[A-Za-z']+$/.test(p)) total += p.length <= 4 ? 1 : Math.ceil(p.length / 4);
    else if (/^[0-9]+$/.test(p)) total += Math.max(1, Math.ceil(p.length / 2));
    else total += 1;
  }
  return total;
}

const fmtTokens = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);
const pct = (n) => `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`;

// ── assertion mining (mirrors src/assertions.ts) ──────────────────────────────

function segment(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.length <= 160) { out.push(t); continue; }
    for (const s of t.split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

function diffSegments(before, after) {
  const n = before.length, m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);

  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) removed.push(before[i++]);
    else added.push(after[j++]);
  }
  while (i < n) removed.push(before[i++]);
  while (j < m) added.push(after[j++]);
  return { added, removed };
}

function rank(segments) {
  return [...new Set(segments)]
    .filter((s) => s.length >= 12 && (s.match(/[A-Za-z0-9]{2,}/g) || []).length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

function assertionsFromEdit(raw, corrected) {
  const { added, removed } = diffSegments(segment(raw), segment(corrected));
  const out = [];
  for (const v of rank(added)) out.push({ kind: "contains", value: v, source: "auto", weight: 2 });
  for (const v of rank(removed)) out.push({ kind: "not_contains", value: v, source: "auto", weight: 1 });
  return out.slice(0, 8);
}

function assertionsFromAccept(output) {
  return rank(segment(output)).slice(0, 3).map((value) => ({ kind: "contains", value, source: "auto", weight: 1 }));
}

function assertionsFromReject(output) {
  return rank(segment(output)).slice(0, 3).map((value) => ({ kind: "not_contains", value, source: "auto", weight: 2 }));
}

// ── demo data ─────────────────────────────────────────────────────────────────

const DEMO_TOOLS = [
  { name: "read_file", description: "Read a UTF-8 text file from the working directory.", tokens: 106 },
  { name: "list_files", description: "List files and directories at a path in the working directory.", tokens: 109 },
  { name: "search_text", description: "Find files whose contents match a case-insensitive substring.", tokens: 158 },
  { name: "run_tests", description: "Run the project's test suite and return failures.", tokens: 132, planned: true },
  { name: "fetch_url", description: "Fetch a URL and return readable text.", tokens: 121, planned: true },
  { name: "query_sql", description: "Run a read-only query against a configured database.", tokens: 186, planned: true },
];

const DEMO_MEMORY = { "TONE.md": 214, "GLOSSARY.md": 388, "REFUND-POLICY.md": 512 };

const DEMO_BASELINE = `Refunds are available within 14 days of purchase.
Contact support@example.com and we will process it.
Shipping costs are refunded in full.`;

const DEMO_CORRECTED = `Refunds are available within 30 days of purchase.
Contact support@example.com and we will process it.
Original shipping costs are non-refundable.`;

function demoState() {
  const loadout = {
    id: "ld_demo",
    name: "support-replies",
    createdAt: new Date().toISOString(),
    model: "qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434/v1",
    systemPrompt:
      "You write short, accurate customer support replies. Match the tone in TONE.md. " +
      "Never invent policy details — if the answer is not in the pinned notes, say so.",
    tools: ["read_file", "search_text"],
    memory: ["TONE.md"],
    params: { temperature: 0.2 },
    contextWindow: 8192,
  };

  const cases = [
    {
      id: "case_demo1",
      createdAt: new Date().toISOString(),
      title: "Draft a refund policy summary for a customer email.",
      input: "Draft a refund policy summary for a customer email.",
      loadoutId: "ld_demo",
      reference: DEMO_CORRECTED,
      origin: { runId: "run_demo1", verdict: "edit", model: "qwen2.5-coder:7b" },
      assertions: assertionsFromEdit(DEMO_BASELINE, DEMO_CORRECTED),
      graders: ["assertions", "judge"],
      antiReference: DEMO_BASELINE,
      tags: ["support"],
    },
    {
      id: "case_demo2",
      createdAt: new Date().toISOString(),
      title: "Reply to a customer asking about EU shipping times.",
      input: "Reply to a customer asking about EU shipping times.",
      loadoutId: "ld_demo",
      reference:
        "EU orders usually arrive in 5-8 working days once dispatched.\nCustoms handling can add up to 3 days for orders outside the EU VAT scheme.",
      origin: { runId: "run_demo2", verdict: "accept", model: "qwen2.5-coder:7b" },
      assertions: [
        { kind: "contains", value: "5-8 working days", source: "manual", weight: 2 },
        { kind: "not_contains", value: "next day delivery", source: "auto", weight: 1 },
      ],
      graders: ["assertions", "judge"],
      tags: ["support"],
    },
    {
      id: "case_demo3",
      createdAt: new Date().toISOString(),
      title: "Summarise this week's open bugs by severity.",
      input: "Summarise this week's open bugs by severity.",
      loadoutId: "ld_demo",
      reference: "",
      origin: { runId: "run_demo3", verdict: "reject", model: "qwen2.5-coder:7b" },
      assertions: [
        { kind: "not_contains", value: "I do not have access to your bug tracker", source: "auto", weight: 2 },
      ],
      graders: ["assertions"],
      tags: ["triage"],
    },
  ];

  const mk = (id, model, scores, speed) => ({
    id,
    createdAt: new Date().toISOString(),
    model,
    baseUrl: loadout.baseUrl,
    loadoutId: loadout.id,
    results: cases.map((c, i) => ({
      caseId: c.id,
      title: c.title,
      output: "",
      score: scores[i],
      graders: [],
      ms: 2400,
      tokensPerSec: speed,
    })),
    summary: {
      cases: cases.length,
      scored: cases.length,
      meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      medianTokensPerSec: speed,
      failures: 0,
    },
  });

  return {
    loadouts: [loadout],
    tools: DEMO_TOOLS,
    cases,
    replays: [
      mk("rep_demo_old", "qwen2.5-coder:7b", [0.42, 0.91, 1], 31.4),
      mk("rep_demo_new", "deepseek-v4-flash", [1, 0.88, 1], 74.2),
    ],
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

const state = {
  live: false,
  view: "loadout",
  loadouts: [],
  tools: [],
  cases: [],
  replays: [],
  activeId: null,
  run: null,
  editing: false,
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function active() {
  return state.loadouts.find((l) => l.id === state.activeId) ?? state.loadouts[0];
}

/** Compute the budget client-side so demo mode reacts exactly like the server. */
function encumbranceOf(loadout) {
  if (!loadout) return { systemTokens: 0, toolTokens: 0, memoryTokens: 0, total: 0, contextWindow: 1, ratio: 0, perMemory: [] };
  if (state.live && loadout.encumbrance) return loadout.encumbrance;

  const systemTokens = estimateTokens(loadout.systemPrompt);
  const toolTokens = loadout.tools.reduce(
    (s, n) => s + (state.tools.find((t) => t.name === n)?.tokens ?? 0),
    0,
  );
  const perMemory = loadout.memory.map((path) => ({
    path,
    tokens: DEMO_MEMORY[path] ?? 260,
    missing: false,
  }));
  const memoryTokens = perMemory.reduce((s, m) => s + m.tokens, 0);
  const total = systemTokens + toolTokens + memoryTokens;
  return {
    systemTokens,
    toolTokens,
    memoryTokens,
    total,
    contextWindow: loadout.contextWindow,
    ratio: loadout.contextWindow > 0 ? total / loadout.contextWindow : 0,
    perMemory,
  };
}

// ── api ───────────────────────────────────────────────────────────────────────

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `${res.status}`);
  return json;
}

async function boot() {
  try {
    // Opened from disk there is no server to find, and the attempt only logs a
    // CORS error to the console.
    if (location.protocol === "file:") throw new Error("no server");
    const snap = await api("/api/state");
    Object.assign(state, snap, { live: true });
    if (!state.loadouts.length) {
      const l = await api("/api/loadouts", "POST", { name: "default" });
      state.loadouts = [l];
    }
  } catch {
    Object.assign(state, demoState(), { live: false });
  }
  state.activeId = state.loadouts[0]?.id ?? null;
  renderAll();
}

async function patchLoadout(changes) {
  const l = active();
  if (!l) return;
  Object.assign(l, changes);
  if (state.live) {
    try {
      const updated = await api(`/api/loadouts/${l.id}`, "PATCH", changes);
      Object.assign(l, updated);
    } catch (e) {
      setHint("run-hint", e.message);
    }
  }
  renderGauge();
  renderLoadout();
}

// ── rendering ─────────────────────────────────────────────────────────────────

function renderAll() {
  renderConn();
  renderGauge();
  renderLoadout();
  renderSuite();
  renderTrials();
  renderCounts();
  showView(state.view);
}

function renderConn() {
  const el = $("#conn");
  el.classList.toggle("is-live", state.live);
  el.classList.toggle("is-demo", !state.live);
  el.querySelector(".conn-text").textContent = state.live ? "connected" : "demo data";
  $("#conn-note").textContent = state.live
    ? "Reading and writing your local suite."
    : "No server found. Equipping and capture still work — nothing is saved.";
}

function renderCounts() {
  $('[data-count="cases"]').textContent = state.cases.length;
  $('[data-count="replays"]').textContent = state.replays.length;
  $("#g-cases").textContent = state.cases.length;
}

function renderGauge() {
  const l = active();
  const e = encumbranceOf(l);
  const free = Math.max(0, e.contextWindow - e.total);

  $("#g-free").textContent = fmtTokens(free);
  $("#g-of").textContent = `of ${fmtTokens(e.contextWindow)} window`;
  $("#g-pct").textContent = pct(e.ratio);
  $("#g-system").textContent = fmtTokens(e.systemTokens);
  $("#g-tools").textContent = fmtTokens(e.toolTokens);
  $("#g-memory").textContent = fmtTokens(e.memoryTokens);
  $("#g-model").textContent = l?.model ?? "—";

  const w = (n) => `${Math.min(100, (n / Math.max(1, e.contextWindow)) * 100)}%`;
  $("#seg-system").style.width = w(e.systemTokens);
  $("#seg-tools").style.width = w(e.toolTokens);
  $("#seg-memory").style.width = w(e.memoryTokens);

  const gauge = $(".gauge");
  gauge.classList.toggle("is-warn", e.ratio >= 0.5 && e.ratio < 0.75);
  gauge.classList.toggle("is-redline", e.ratio >= 0.75);

  const warn = $("#g-warn");
  if (e.ratio >= 0.75) {
    warn.hidden = false;
    warn.textContent = "Past the redline. The harness is crowding out the task itself — drop a tool or a pinned note.";
  } else if (e.ratio >= 0.5) {
    warn.hidden = false;
    warn.textContent = "Over half the window is gone before the task starts.";
  } else {
    warn.hidden = true;
  }

  const speed = state.run?.stats?.tokensPerSec ?? state.replays.at(-1)?.summary.medianTokensPerSec;
  $("#g-speed").textContent = speed ? `${speed.toFixed(1)} tok/s` : "—";

  renderStandings(l);
}

/** Best score per model, so re-running a trial replaces rather than duplicates. */
function renderStandings(loadout) {
  const best = new Map();
  for (const r of state.replays) {
    const prev = best.get(r.model);
    if (!prev || r.summary.meanScore > prev.summary.meanScore) best.set(r.model, r);
  }

  const rows = [...best.values()].sort((a, b) => b.summary.meanScore - a.summary.meanScore).slice(0, 5);
  $("#standings").hidden = rows.length === 0;
  if (!rows.length) return;

  $("#standings-list").innerHTML = rows
    .map((r) => {
      const s = r.summary.meanScore;
      const hue = s >= 0.8 ? "var(--green)" : s >= 0.5 ? "var(--system)" : "var(--red)";
      return `<li class="standing ${r.model === loadout?.model ? "is-current" : ""}">
        <span class="standing-name">${esc(r.model)}</span>
        <span class="standing-score" style="color:${hue}">${pct(s)}</span>
        <span class="standing-track"><span class="standing-fill" style="width:${s * 100}%;background:${hue}"></span></span>
      </li>`;
    })
    .join("");
}

function renderLoadout() {
  const l = active();
  if (!l) return;

  const picker = $("#loadout-picker");
  picker.innerHTML = state.loadouts.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
  picker.value = l.id;

  if (document.activeElement !== $("#f-model")) $("#f-model").value = l.model;
  if (document.activeElement !== $("#f-baseurl")) $("#f-baseurl").value = l.baseUrl;
  if (document.activeElement !== $("#f-context")) $("#f-context").value = l.contextWindow;
  if (document.activeElement !== $("#f-system")) $("#f-system").value = l.systemPrompt;
  $("#cost-system").textContent = `${estimateTokens(l.systemPrompt)} tok`;

  const costClass = (n) => (n < 120 ? "cost-1" : n < 170 ? "cost-2" : "cost-3");

  $("#gear-list").innerHTML = state.tools
    .map((t) => {
      const on = l.tools.includes(t.name);
      return `<li class="gear-card ${on ? "is-on" : ""} ${t.planned ? "is-planned" : ""}">
        <span class="gear-name">${esc(t.name)}${t.planned ? '<span class="chip">not built yet</span>' : ""}</span>
        <span class="cost ${costClass(t.tokens)}">${t.tokens} tok</span>
        <button class="btn" data-tool="${esc(t.name)}" ${t.planned ? "disabled" : ""}>${on ? "Unequip" : "Equip"}</button>
        <p class="gear-desc">${esc(t.description)}</p>
      </li>`;
    })
    .join("");

  const e = encumbranceOf(l);
  $("#pin-list").innerHTML = l.memory.length
    ? l.memory
        .map((path) => {
          const m = e.perMemory.find((x) => x.path === path);
          return `<li class="pin ${m?.missing ? "is-missing" : ""}">
            <span>${esc(path)}</span>
            <span class="cost pin-cost ${m?.missing ? "" : "cost-2"}">${m?.missing ? "not found" : `${m?.tokens ?? 0} tok`}</span>
            <button class="btn" data-unpin="${esc(path)}">Remove</button>
          </li>`;
        })
        .join("")
    : '<li><p class="empty">Nothing pinned. The model starts every task with no context about you.</p></li>';
}

function renderSuite() {
  const el = $("#suite-list");
  if (!state.cases.length) {
    el.innerHTML =
      '<div class="panel"><p class="empty">No cases yet. Run a task and give it a verdict — that is all it takes.</p></div>';
    return;
  }
  el.innerHTML = state.cases
    .map((c) => {
      const v = c.origin.verdict;
      return `<article class="case">
        <div class="case-head">
          <span class="verdict-chip vc-${v}">${v === "edit" ? "fixed" : v === "accept" ? "kept" : "rejected"}</span>
          <h3 class="case-title">${esc(c.title)}</h3>
          <span class="case-meta">${c.assertions.length} check${c.assertions.length === 1 ? "" : "s"}${c.tags.length ? ` · ${c.tags.map((t) => `#${esc(t)}`).join(" ")}` : ""}</span>
        </div>
        <ul class="asserts" role="list">${c.assertions.map(assertHtml).join("")}</ul>
      </article>`;
    })
    .join("");
}

function assertHtml(a, i = 0) {
  const must = a.kind === "contains";
  return `<li class="assert ${must ? "assert-must" : "assert-never"}" style="--i:${i}">
    <span class="assert-kind">${must ? "must say" : "never say"}</span>
    <span class="assert-value">${esc(a.value)}</span>
  </li>`;
}

function scoreClass(s) {
  return s >= 0.8 ? "s-good" : s >= 0.5 ? "s-mid" : "s-bad";
}

function renderTrials() {
  const el = $("#trial-results");
  if (!state.replays.length) {
    el.innerHTML = "";
    return;
  }
  const recent = [...state.replays].slice(-4).reverse();

  const trials = recent
    .map(
      (r) => `<div class="panel trial">
      <div class="trial-head">
        <h3 class="trial-model">${esc(r.model)}</h3>
        <span class="panel-note">${r.summary.medianTokensPerSec.toFixed(1)} tok/s median</span>
        <span class="trial-mean ${scoreClass(r.summary.meanScore).replace("s-", "mean-")}">${pct(r.summary.meanScore)}</span>
      </div>
      ${r.results
        .map(
          (x) => `<div class="result ${scoreClass(x.score)}">
          <span class="result-score">${pct(x.score)}</span>
          <div class="result-body">
            <div class="result-title">${esc(x.title)}</div>
            <div class="result-track"><div class="result-fill" style="width:${x.score * 100}%"></div></div>
          </div>
        </div>`,
        )
        .join("")}
    </div>`,
    )
    .join("");

  el.innerHTML = compareHtml() + trials;
}

function compareHtml() {
  if (state.replays.length < 2) return "";
  const b = state.replays.at(-1);
  const a = state.replays.at(-2);
  const byCase = new Map(a.results.map((r) => [r.caseId, r]));
  const moves = [];

  for (const rb of b.results) {
    const ra = byCase.get(rb.caseId);
    if (!ra) continue;
    const d = rb.score - ra.score;
    if (Math.abs(d) >= 0.15) {
      moves.push(
        `<span class="delta-line ${d > 0 ? "delta-up" : "delta-down"}">${d > 0 ? "▲" : "▼"} ${esc(rb.title)} — ${pct(ra.score)} → ${pct(rb.score)}</span>`,
      );
    }
  }

  const dm = b.summary.meanScore - a.summary.meanScore;
  return `<div class="panel"><div class="delta">
    <span class="delta-line"><b>${esc(a.model)}</b> → <b>${esc(b.model)}</b></span>
    <span class="delta-line ${dm >= 0 ? "delta-up" : "delta-down"}">${pct(a.summary.meanScore)} → ${pct(b.summary.meanScore)} (${dm >= 0 ? "+" : ""}${(dm * 100).toFixed(1)} pts) · ${a.summary.medianTokensPerSec.toFixed(0)} → ${b.summary.medianTokensPerSec.toFixed(0)} tok/s</span>
    ${moves.join("") || '<span class="delta-line">No case moved by more than 15 points.</span>'}
  </div></div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setHint(id, text) {
  $(`#${id}`).textContent = text;
}

function showView(view) {
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$(".nav-item").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
}

// ── run + capture ─────────────────────────────────────────────────────────────

function demoAnswer(task) {
  if (/refund/i.test(task)) return DEMO_BASELINE;
  return `Here is a draft for: ${task.trim()}\n\nI have kept it short and avoided inventing specifics that are not in the pinned notes.`;
}

async function doRun() {
  const input = $("#task-input").value.trim();
  if (!input) { setHint("run-hint", "Type the task first."); return; }

  const l = active();
  state.busy = true;
  $("#btn-run").disabled = true;
  setHint("run-hint", "Running…");
  $("#capture-panel").hidden = true;

  try {
    if (state.live) {
      state.run = await api("/api/run", "POST", { loadoutId: l.id, input });
    } else {
      await new Promise((r) => setTimeout(r, 550));
      const output = demoAnswer(input);
      state.run = {
        id: `run_demo_${Date.now()}`,
        input,
        output,
        model: l.model,
        stats: { ms: 2380, tokensPerSec: 31.4, encumbranceRatio: encumbranceOf(l).ratio },
      };
    }
    showOutput();
    setHint("run-hint", "");
  } catch (e) {
    setHint("run-hint", e.message);
  } finally {
    state.busy = false;
    $("#btn-run").disabled = false;
    renderGauge();
  }
}

function showOutput() {
  const r = state.run;
  $("#output-panel").hidden = false;
  $("#run-output").hidden = false;
  $("#run-output").textContent = r.output || "(no output)";
  $("#run-edit").hidden = true;
  $("#verdict-bar").hidden = false;
  $("#edit-bar").hidden = true;
  state.editing = false;
  $("#run-stats").textContent = `${r.stats.ms} ms · ${r.stats.tokensPerSec.toFixed(1)} tok/s · harness took ${pct(r.stats.encumbranceRatio)}`;
}

function beginEdit() {
  state.editing = true;
  $("#run-output").hidden = true;
  $("#run-edit").hidden = false;
  $("#run-edit").value = state.run.output;
  $("#verdict-bar").hidden = true;
  $("#edit-bar").hidden = false;
  $("#run-edit").focus();
}

async function capture(kind, correctedOutput) {
  const r = state.run;
  let evalCase;

  if (state.live) {
    try {
      evalCase = await api("/api/capture", "POST", {
        runId: r.id,
        kind,
        ...(correctedOutput ? { correctedOutput } : {}),
      });
      const snap = await api("/api/state");
      Object.assign(state, snap);
    } catch (e) {
      setHint("run-hint", e.message);
      return;
    }
  } else {
    const assertions =
      kind === "edit"
        ? assertionsFromEdit(r.output, correctedOutput)
        : kind === "accept"
          ? assertionsFromAccept(r.output)
          : assertionsFromReject(r.output);
    evalCase = {
      id: `case_demo_${Date.now()}`,
      createdAt: new Date().toISOString(),
      title: r.input.split("\n")[0].slice(0, 72),
      input: r.input,
      loadoutId: active().id,
      reference: kind === "edit" ? correctedOutput : kind === "accept" ? r.output : "",
      origin: { runId: r.id, verdict: kind, model: r.model },
      assertions,
      graders: kind === "reject" ? ["assertions"] : ["assertions", "judge"],
      tags: [],
    };
    state.cases.push(evalCase);
  }

  $("#output-panel").hidden = true;
  $("#capture-panel").hidden = false;
  $("#capture-note").textContent =
    kind === "edit"
      ? "Your correction became these checks. Every future model gets graded on them."
      : kind === "accept"
        ? "Kept as a reference answer, with a few anchors to catch a bad regression."
        : "Recorded as something no model should say again.";
  $("#capture-asserts").innerHTML = evalCase.assertions.length
    ? evalCase.assertions.map((a, i) => assertHtml(a, i)).join("")
    : '<li><p class="empty">Nothing distinctive enough to pin down automatically — you can add a check by hand.</p></li>';

  state.run = null;
  $("#task-input").value = "";
  renderSuite();
  renderCounts();
}

async function doTrial() {
  const model = $("#trial-model").value.trim();
  if (!model) { setHint("trial-hint", "Which model should the suite run against?"); return; }
  if (!state.cases.length) { setHint("trial-hint", "Capture at least one case first."); return; }

  $("#btn-trial").disabled = true;
  setHint("trial-hint", `Running ${state.cases.length} case${state.cases.length === 1 ? "" : "s"}…`);

  try {
    if (state.live) {
      const baseUrl = $("#trial-baseurl").value.trim();
      await api("/api/replay", "POST", { model, ...(baseUrl ? { baseUrl } : {}) });
      Object.assign(state, await api("/api/state"));
    } else {
      await new Promise((r) => setTimeout(r, 850));
      // Demo scoring is arbitrary but stable per model name, so repeated runs
      // of the same name do not jump around.
      const seed = [...model].reduce((s, c) => s + c.charCodeAt(0), 0);
      const scores = state.cases.map((_, i) => Math.min(1, 0.45 + (((seed + i * 37) % 60) / 100)));
      state.replays.push({
        id: `rep_demo_${Date.now()}`,
        createdAt: new Date().toISOString(),
        model,
        baseUrl: active().baseUrl,
        loadoutId: active().id,
        results: state.cases.map((c, i) => ({
          caseId: c.id, title: c.title, output: "", score: scores[i], graders: [], ms: 1800,
          tokensPerSec: 40 + (seed % 50),
        })),
        summary: {
          cases: state.cases.length, scored: state.cases.length,
          meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
          medianTokensPerSec: 40 + (seed % 50), failures: 0,
        },
      });
    }
    setHint("trial-hint", "");
    renderTrials();
    renderCounts();
    renderGauge();
  } catch (e) {
    setHint("trial-hint", e.message);
  } finally {
    $("#btn-trial").disabled = false;
  }
}

// ── events ────────────────────────────────────────────────────────────────────

$$(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

$("#loadout-picker").addEventListener("change", (e) => {
  state.activeId = e.target.value;
  renderGauge();
  renderLoadout();
});

$("#f-system").addEventListener("input", (e) => {
  const l = active();
  l.systemPrompt = e.target.value;
  $("#cost-system").textContent = `${estimateTokens(l.systemPrompt)} tok`;
  renderGauge();
});
$("#f-system").addEventListener("change", (e) => patchLoadout({ systemPrompt: e.target.value }));
$("#f-model").addEventListener("change", (e) => patchLoadout({ model: e.target.value }));
$("#f-baseurl").addEventListener("change", (e) => patchLoadout({ baseUrl: e.target.value }));
$("#f-context").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  if (Number.isFinite(n) && n > 0) { active().contextWindow = n; renderGauge(); }
});
$("#f-context").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  if (Number.isFinite(n) && n > 0) patchLoadout({ contextWindow: n });
});

$("#gear-list").addEventListener("click", (e) => {
  const name = e.target.dataset?.tool;
  if (!name) return;
  const l = active();
  const tools = l.tools.includes(name) ? l.tools.filter((t) => t !== name) : [...l.tools, name];
  patchLoadout({ tools });
});

$("#pin-list").addEventListener("click", (e) => {
  const path = e.target.dataset?.unpin;
  if (!path) return;
  patchLoadout({ memory: active().memory.filter((m) => m !== path) });
});

$("#pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = $("#pin-input").value.trim();
  if (!path) return;
  const l = active();
  if (!l.memory.includes(path)) patchLoadout({ memory: [...l.memory, path] });
  $("#pin-input").value = "";
});

$("#btn-run").addEventListener("click", doRun);
$("#task-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doRun();
});

$("#verdict-bar").addEventListener("click", (e) => {
  const v = e.target.dataset?.verdict;
  if (!v) return;
  if (v === "edit") beginEdit();
  else capture(v);
});

$("#btn-save-edit").addEventListener("click", () => {
  const corrected = $("#run-edit").value;
  if (corrected.trim() === state.run.output.trim()) capture("accept");
  else capture("edit", corrected);
});
$("#btn-cancel-edit").addEventListener("click", showOutput);

$("#btn-trial").addEventListener("click", doTrial);

boot();
