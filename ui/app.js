/* LocalHarness UI
 *
 * The engine underneath counts tokens, mines assertions and computes mean
 * scores. None of those words appear on screen unless you ask for them. What
 * appears instead is room to think, things it can do, and things it learned —
 * because the person this is for should never have to hold a mental model of
 * a context window in order to own a good assistant.
 *
 * Talks to the local server when there is one, and falls back to a worked
 * demo when there is not. The fallback really recomputes and really mines, so
 * the two moments that matter are never faked.
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

const assertionsFromAccept = (o) =>
  rank(segment(o)).slice(0, 3).map((value) => ({ kind: "contains", value, source: "auto", weight: 1 }));
const assertionsFromReject = (o) =>
  rank(segment(o)).slice(0, 3).map((value) => ({ kind: "not_contains", value, source: "auto", weight: 2 }));

// ── the catalogue ─────────────────────────────────────────────────────────────

/**
 * Presentation only — the engine will run any model the endpoint serves. The
 * point is that "qwen2.5-coder:7b" tells a normal person nothing, while "needs
 * a laptop with 8 GB to spare" tells them whether to bother.
 *
 * Sizes are the usual quantised downloads and are approximate on purpose.
 */
const BRAINS = [
  {
    id: "llama3.2:3b",
    name: "Small and quick",
    note: "Fine for short replies, tidying up text and simple questions.",
    needs: "About 2 GB. Runs on almost any laptop.",
  },
  {
    id: "qwen2.5-coder:7b",
    name: "Good all-rounder",
    note: "Handles code and careful writing. A sensible default.",
    needs: "About 5 GB. Wants 8 GB of memory free.",
  },
  {
    id: "deepseek-v4-flash",
    name: "New and fast",
    note: "The newest open model. Worth testing against what you've taught yours.",
    needs: "Check what your machine can spare before downloading.",
  },
  {
    id: "llama3.3:70b",
    name: "Slow but thorough",
    note: "Better at long, careful work. You will feel the wait.",
    needs: "About 40 GB. Needs a serious machine.",
  },
];

const ABILITIES = {
  read_file: { name: "Read a file", note: "Open a document you point it at." },
  list_files: { name: "See what I have", note: "Look through the names of your files." },
  search_text: { name: "Search my files", note: "Find which of your files mention something." },
  run_tests: { name: "Check my code works", note: "Run your tests and report what failed.", soon: true },
  fetch_url: { name: "Look things up online", note: "Read a web page you give it.", soon: true },
  query_sql: { name: "Ask about my data", note: "Answer questions from a spreadsheet or database.", soon: true },
};

const DEMO_NOTE_SIZES = { "TONE.md": 214, "about-my-work.md": 260, "refund-policy.md": 512, "GLOSSARY.md": 388 };

const DEMO_BEFORE = `Refunds are available within 14 days of purchase.
Contact support@example.com and we will process it.
Shipping costs are refunded in full.`;

const DEMO_AFTER = `Refunds are available within 30 days of purchase.
Contact support@example.com and we will process it.
Original shipping costs are non-refundable.`;

function demoState() {
  const assistant = {
    id: "ld_demo",
    name: "My assistant",
    createdAt: new Date().toISOString(),
    model: "qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434/v1",
    systemPrompt:
      "Write the way I do: short sentences, no jargon, no corporate padding. " +
      "Never invent policy details — if the answer isn't in my notes, say you don't know.",
    tools: ["read_file", "search_text"],
    memory: ["TONE.md"],
    params: { temperature: 0.2 },
    contextWindow: 8192,
  };

  const cases = [
    {
      id: "case_d1",
      createdAt: "2026-08-01T10:12:00Z",
      title: "Write a reply to a customer asking about our refund policy.",
      input: "Write a reply to a customer asking about our refund policy.",
      loadoutId: "ld_demo",
      reference: DEMO_AFTER,
      origin: { runId: "r1", verdict: "edit", model: "qwen2.5-coder:7b" },
      assertions: assertionsFromEdit(DEMO_BEFORE, DEMO_AFTER),
      graders: ["assertions", "judge"],
      tags: [],
    },
    {
      id: "case_d2",
      createdAt: "2026-08-02T14:40:00Z",
      title: "Answer a customer asking how long delivery takes in Europe.",
      input: "Answer a customer asking how long delivery takes in Europe.",
      loadoutId: "ld_demo",
      reference: "EU orders usually arrive in 5-8 working days once they're dispatched.",
      origin: { runId: "r2", verdict: "accept", model: "qwen2.5-coder:7b" },
      assertions: [
        { kind: "contains", value: "5-8 working days", source: "manual", weight: 2 },
        { kind: "not_contains", value: "next day delivery", source: "auto", weight: 1 },
      ],
      graders: ["assertions", "judge"],
      tags: [],
    },
    {
      id: "case_d3",
      createdAt: "2026-08-03T09:05:00Z",
      title: "Summarise this week's support emails.",
      input: "Summarise this week's support emails.",
      loadoutId: "ld_demo",
      reference: "",
      origin: { runId: "r3", verdict: "reject", model: "qwen2.5-coder:7b" },
      assertions: [
        { kind: "not_contains", value: "I don't have access to your email", source: "auto", weight: 2 },
      ],
      graders: ["assertions"],
      tags: [],
    },
  ];

  const mk = (id, model, scores, speed) => ({
    id, createdAt: new Date().toISOString(), model, baseUrl: assistant.baseUrl, loadoutId: assistant.id,
    results: cases.map((c, i) => ({
      caseId: c.id, title: c.title, output: "", score: scores[i], graders: [], ms: 2400, tokensPerSec: speed,
    })),
    summary: {
      cases: cases.length, scored: cases.length,
      meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      medianTokensPerSec: speed, failures: 0,
    },
  });

  return {
    loadouts: [assistant],
    tools: Object.entries(ABILITIES)
      .filter(([, a]) => !a.soon)
      .map(([name]) => ({ name, description: ABILITIES[name].note, tokens: { read_file: 106, list_files: 109, search_text: 158 }[name] })),
    cases,
    replays: [mk("rep_a", "qwen2.5-coder:7b", [1, 0.85, 0.38], 31.4)],
  };
}

/**
 * Demo outcomes are fixed per brain rather than random, so clicking around the
 * prototype shows the range the product actually has to report — clearly
 * better, faster but forgetful, and slow but reliable — instead of noise.
 * Anything typed by hand falls back to a stable hash.
 */
const DEMO_TRIALS = {
  "deepseek-v4-flash": { remembers: 0.78, speed: 74 },
  "llama3.2:3b": { remembers: 0.3, speed: 96 },
  "llama3.3:70b": { remembers: 1, speed: 9 },
};

function demoTrial(model, n) {
  const profile = DEMO_TRIALS[model];
  if (!profile) {
    const seed = [...model].reduce((s, c) => s + c.charCodeAt(0), 0);
    return {
      scores: Array.from({ length: n }, (_, i) => Math.min(1, 0.45 + ((seed + i * 41) % 55) / 100)),
      speed: 25 + (seed % 60),
    };
  }
  const passing = Math.round(n * profile.remembers);
  return {
    scores: Array.from({ length: n }, (_, i) => (i < passing ? 1 : 0.38)),
    speed: profile.speed,
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

const state = {
  live: false,
  view: "assistant",
  loadouts: [], tools: [], cases: [], replays: [],
  activeId: null,
  run: null,
  lastTry: null,
  tuneJob: null,
  tuneResult: null,
  dismissed: new Set(),
  poller: null,
  health: null,
  settings: { autoTune: false, watchForNewModels: true, idleMinutes: 10, tuneAfterLessons: 3 },
  editing: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const me = () => state.loadouts.find((l) => l.id === state.activeId) ?? state.loadouts[0];

/** Every ability the catalogue knows about, merged with what the server has. */
function allAbilities() {
  const known = new Map(state.tools.map((t) => [t.name, t.tokens]));
  return Object.entries(ABILITIES).map(([name, a]) => ({
    name,
    label: a.name,
    note: a.note,
    soon: a.soon || !known.has(name),
    tokens: known.get(name) ?? { run_tests: 132, fetch_url: 121, query_sql: 186 }[name] ?? 130,
  }));
}

function brainFor(model) {
  return BRAINS.find((b) => b.id === model) ?? { id: model, name: model, note: "", needs: "" };
}

/**
 * What's actually on this machine, first; the catalogue after.
 *
 * Showing someone four models they could theoretically run is a worse answer
 * than showing them the two they already have. Anything installed that the
 * catalogue doesn't recognise still gets listed — it's theirs, and the app
 * having no opinion about it is not a reason to hide it.
 */
function brainOptions() {
  const installed = state.health?.models ?? [];
  const seen = new Set();
  const out = [];

  for (const id of installed) {
    seen.add(id);
    const known = BRAINS.find((b) => b.id === id);
    out.push(known ? { ...known, installed: true } : { id, name: id, note: "Already on this computer.", needs: "", installed: true });
  }
  for (const b of BRAINS) {
    if (!seen.has(b.id)) out.push({ ...b, installed: false });
  }
  // Never hide the one currently in use, even if the probe missed it.
  const current = me()?.model;
  if (current && !out.some((b) => b.id === current)) {
    out.unshift({ ...brainFor(current), installed: true });
  }
  return out;
}

async function checkHealth() {
  if (!state.live) {
    // The demo shows both states: two installed, two not.
    state.health = { ok: true, models: ["qwen2.5-coder:7b", "llama3.2:3b"], baseUrl: me()?.baseUrl };
    return;
  }
  try {
    state.health = await api(`/api/health?baseUrl=${encodeURIComponent(me()?.baseUrl ?? "")}`);
  } catch (e) {
    state.health = { ok: false, models: [], error: e.message };
  }
}

function renderHealth() {
  const h = state.health;
  const card = $("#health-card");
  if (!h) { card.hidden = true; return; }

  // A working setup does not need a banner about being fine.
  if (h.ok && h.models.length) { card.hidden = true; return; }

  card.hidden = false;
  card.classList.toggle("is-ok", !!h.ok);

  if (h.ok && !h.models.length) {
    setText("health-title", "Nothing downloaded yet");
    $("#health-body").innerHTML =
      "Something is running on this computer, but it hasn't got a model yet. " +
      "Download one with <code>ollama pull llama3.2</code> and I'll pick it up.";
    return;
  }

  setText("health-title", "I can't find a model on this computer");
  $("#health-body").innerHTML =
    `Nothing is answering at <code>${esc(h.baseUrl ?? "")}</code>${h.error ? ` — ${esc(h.error)}` : ""}. ` +
    "The usual fix is to install <b>Ollama</b>, open it once, and run <code>ollama pull llama3.2</code>. " +
    "You can also point this at a hosted model under &ldquo;Use a brain that isn't listed&rdquo;.";
}

function roomOf(l) {
  if (!l) return { instructions: 0, abilities: 0, notes: 0, total: 0, window: 1, ratio: 0, perNote: [] };
  if (state.live && l.encumbrance) {
    const e = l.encumbrance;
    return {
      instructions: e.systemTokens, abilities: e.toolTokens, notes: e.memoryTokens,
      total: e.total, window: e.contextWindow, ratio: e.ratio, perNote: e.perMemory,
    };
  }
  const instructions = estimateTokens(l.systemPrompt);
  const abilities = l.tools.reduce((s, n) => s + (allAbilities().find((a) => a.name === n)?.tokens ?? 0), 0);
  const perNote = l.memory.map((path) => ({ path, tokens: DEMO_NOTE_SIZES[path] ?? 260, missing: false }));
  const notes = perNote.reduce((s, m) => s + m.tokens, 0);
  const total = instructions + abilities + notes;
  return { instructions, abilities, notes, total, window: l.contextWindow, ratio: total / (l.contextWindow || 1), perNote };
}

/** A share of the room, which people read fine — unlike a token count. */
function sharePct(tokens, window) {
  const p = (tokens / (window || 1)) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function share(tokens, window) {
  const p = (tokens / (window || 1)) * 100;
  if (p < 0.5) return "a sliver of its room";
  return `${sharePct(tokens, window)} of its room`;
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
    if (location.protocol === "file:") throw new Error("no server");
    const snap = await api("/api/state");
    Object.assign(state, snap, { live: true });
    if (!state.loadouts.length) {
      state.loadouts = [await api("/api/loadouts", "POST", { name: "My assistant" })];
    }
  } catch {
    Object.assign(state, demoState(), { live: false });
  }
  state.activeId = state.loadouts[0]?.id ?? null;

  // A pass that ran while the app was closed left its answer on disk. Pick it
  // up, or the unattended work was pointless.
  const waiting = (state.findings ?? []).at(-1);
  if (waiting) state.tuneResult = waiting;

  await checkHealth();
  renderAll();
  renderTuneResults();
  renderSettings();
}

function renderSettings() {
  const s = state.settings ?? {};
  $("#set-autotune").checked = !!s.autoTune;
  $("#set-watch").checked = !!s.watchForNewModels;

  const bits = [];
  if (s.autoTune) {
    bits.push(`It'll start a pass once you've taught it ${s.tuneAfterLessons} new things and left it alone for ${s.idleMinutes} minutes.`);
  }
  if (s.lastTuneAt) bits.push(`Last looked ${whenText(s.lastTuneAt)}.`);
  if (!state.live) bits.push("In this demo nothing runs on a timer.");
  setText("set-status", bits.join(" "));
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  renderSettings();
  if (state.live) {
    try {
      state.settings = await api("/api/settings", "PATCH", patch);
      renderSettings();
    } catch (e) {
      setText("tune-hint", e.message);
    }
  }
}

async function change(patch) {
  const l = me();
  if (!l) return;
  Object.assign(l, patch);
  if (state.live) {
    try {
      Object.assign(l, await api(`/api/loadouts/${l.id}`, "PATCH", patch));
    } catch (e) {
      setText("run-hint", e.message);
    }
  }
  renderAssistant();
  renderTop();
}

// ── render ────────────────────────────────────────────────────────────────────

function setText(id, t) { $(`#${id}`).textContent = t; }

function renderAll() {
  renderTop();
  renderHealth();
  renderAssistant();
  renderLearned();
  renderTryList();
  show(state.view);
}

function renderTop() {
  const l = me();
  const n = state.cases.length;
  setText("who-name", l?.name && l.name !== "default" ? l.name : "Your assistant");
  setText(
    "who-sub",
    `${brainFor(l?.model).name}${state.live ? "" : " · demo"} · ${n} thing${n === 1 ? "" : "s"} learned`,
  );
  setText("pip-learned", n);

  // A waiting improvement is the one thing worth pulling someone back for.
  const waiting = liveFindings().length;
  const pip = $("#pip-tune");
  pip.hidden = waiting === 0;
  pip.textContent = waiting;

  setText("tune-scope", tuneScopeNote());
}

function renderAssistant() {
  const l = me();
  if (!l) return;
  const r = roomOf(l);

  // room to think
  const card = $(".room");
  card.classList.toggle("is-tight", r.ratio >= 0.6 && r.ratio < 0.8);
  card.classList.toggle("is-full", r.ratio >= 0.8);
  setText(
    "room-verdict",
    r.ratio < 0.35 ? "Plenty of room" : r.ratio < 0.6 ? "Comfortable" : r.ratio < 0.8 ? "Getting full" : "Too full",
  );
  setText(
    "room-note",
    r.ratio >= 0.8
      ? "There's barely room left for your actual question. It will start losing track of what you said. Take something away."
      : r.ratio >= 0.6
        ? "It's carrying a lot before you've even asked anything. Consider dropping an ability or a note."
        : "Everything you give it — instructions, abilities, notes — takes up space it could be using to think about your actual question.",
  );
  const w = (n) => `${Math.min(100, (n / (r.window || 1)) * 100)}%`;
  $("#seg-instructions").style.width = w(r.instructions);
  $("#seg-abilities").style.width = w(r.abilities);
  $("#seg-notes").style.width = w(r.notes);
  setText("room-instructions", sharePct(r.instructions, r.window));
  setText("room-abilities", sharePct(r.abilities, r.window));
  setText("room-notes", sharePct(r.notes, r.window));
  setText("room-nerd", `${r.total} of ${r.window} tokens · ${(r.ratio * 100).toFixed(1)}% · ${l.model} @ ${l.baseUrl}`);

  // brains
  $("#brain-list").innerHTML = brainOptions().map((b) => brainHtml(b, b.id === l.model, "pick")).join("");

  if (document.activeElement !== $("#f-model")) $("#f-model").value = l.model;
  if (document.activeElement !== $("#f-baseurl")) $("#f-baseurl").value = l.baseUrl;
  if (document.activeElement !== $("#f-context")) $("#f-context").value = l.contextWindow;
  if (document.activeElement !== $("#f-system")) $("#f-system").value = l.systemPrompt;

  // abilities
  $("#ability-list").innerHTML = allAbilities()
    .map((a) => {
      const on = l.tools.includes(a.name);
      return `<li class="ability ${on ? "is-on" : ""} ${a.soon ? "is-soon" : ""}">
        <span class="ability-name">${esc(a.label)}${a.soon ? '<span class="tagline">not built yet</span>' : ""}</span>
        <button class="btn ability-btn" data-ability="${esc(a.name)}" ${a.soon ? "disabled" : ""}>${on ? "Remove" : "Give it this"}</button>
        <span class="ability-note">${esc(a.note)}</span>
        <span class="ability-cost">Takes up ${share(a.tokens, r.window)}<span class="nerd-only mono"> · ${a.tokens} tok · ${esc(a.name)}</span></span>
      </li>`;
    })
    .join("");

  // things it always knows
  $("#note-list").innerHTML = l.memory.length
    ? l.memory
        .map((path) => {
          const m = r.perNote.find((x) => x.path === path);
          return `<li class="note ${m?.missing ? "is-missing" : ""}">
            <span>${esc(path)}</span>
            <span class="note-meta">${m?.missing ? "can't find this file" : `takes up ${share(m?.tokens ?? 0, r.window)}`}</span>
            <button class="btn" data-forget="${esc(path)}">Remove</button>
          </li>`;
        })
        .join("")
    : '<li><p class="empty">Nothing yet. Add a file and it will read it before every answer.</p></li>';
}

function brainHtml(b, current, action) {
  const tag = current
    ? '<span class="badge">using this</span>'
    : b.installed === false
      ? '<span class="badge badge-soft">not downloaded</span>'
      : "";
  return `<li>
    <button class="brain ${current ? "is-on" : ""}" data-brain="${esc(b.id)}" data-action="${action}" ${current && action === "pick" ? "disabled" : ""}>
      <span class="brain-name">${esc(b.name)}${tag}</span>
      <span class="brain-pick">${current ? "" : action === "pick" ? "Use this" : "Test it"}</span>
      <span class="brain-note">${esc(b.note)}</span>
      <span class="brain-needs">${esc(b.needs)}<span class="nerd-only mono"> · ${esc(b.id)}</span></span>
    </button>
  </li>`;
}

function ruleHtml(a, i = 0, editableCaseId = null) {
  const always = a.kind === "contains";
  return `<li class="rule ${always ? "rule-always" : "rule-never"}" style="--i:${i}">
    <span class="rule-kind">${always ? "Always say" : "Never say"}</span>
    <span class="rule-text">${esc(a.value)}${
      editableCaseId
        ? `<button class="rule-drop" data-drop="${esc(editableCaseId)}" data-index="${i}" title="Remove this rule" aria-label="Remove this rule">×</button>`
        : ""
    }</span>
  </li>`;
}

function whenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function renderLearned() {
  const el = $("#learned-list");
  if (!state.cases.length) {
    el.innerHTML = `<div class="card">
      <p class="empty">Nothing yet. Ask it to do something on the previous tab, then tell it whether it got it right — that's all there is to it.</p>
    </div>`;
    return;
  }
  const tagFor = {
    edit: ["tag-fixed", "you fixed it"],
    accept: ["tag-kept", "you kept it"],
    reject: ["tag-wrong", "you said no"],
  };

  el.innerHTML = state.cases
    .map((c) => {
      // An inferred signal must never be dressed up as something you said.
      const [cls, label] =
        c.origin.source === "implicit"
          ? ["tag-kept", "you used it"]
          : (tagFor[c.origin.verdict] ?? ["", c.origin.verdict]);
      const open = state.editing === c.id;

      return `<article class="card lesson">
        <div class="lesson-head">
          <h2 class="lesson-title">${esc(c.title)}</h2>
        </div>
        <div class="lesson-head">
          <span class="tagline ${cls}">${label}</span>
          <button class="lesson-edit" data-edit="${esc(c.id)}">${open ? "Done" : "Change this"}</button>
          <span class="lesson-when">${whenText(c.createdAt)}</span>
        </div>
        ${c.assertions.length
          ? `<ul class="rules" role="list">${c.assertions.map((a, i) => ruleHtml(a, i, open ? c.id : null)).join("")}</ul>`
          : `<p class="empty">${c.origin.source === "implicit"
              ? "Kept as an example of a good answer. No hard rules — you copied it rather than telling it what mattered."
              : "No rules from this one, but the example is kept."}</p>`}
        ${open ? `<div class="lesson-actions">
          <button class="btn" data-forget-lesson="${esc(c.id)}">Forget this entirely</button>
          <span class="hint">Removing a rule stops it being checked from now on.</span>
        </div>` : ""}
      </article>`;
    })
    .join("");
}

async function dropRule(caseId, index) {
  const c = state.cases.find((x) => x.id === caseId);
  if (!c) return;
  const assertions = c.assertions.filter((_, i) => i !== index);
  c.assertions = assertions;
  if (state.live) {
    try {
      await api(`/api/cases/${caseId}`, "PATCH", { assertions });
    } catch (e) {
      setText("run-hint", e.message);
    }
  }
  renderLearned();
}

async function forgetLesson(caseId) {
  state.cases = state.cases.filter((c) => c.id !== caseId);
  state.editing = null;
  if (state.live) {
    try {
      await api(`/api/cases/${caseId}`, "DELETE");
    } catch (e) {
      setText("run-hint", e.message);
    }
  }
  renderLearned();
  renderTop();
}

function renderTryList() {
  const l = me();
  $("#try-list").innerHTML = brainOptions().filter((b) => b.id !== l?.model).map((b) => brainHtml(b, false, "try")).join("");
}

function show(view) {
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$(".tab").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.view === view)));
  window.scrollTo({ top: 0, behavior: "instant" });
}

// ── asking it something ───────────────────────────────────────────────────────

function demoAnswer(task) {
  if (/refund/i.test(task)) return DEMO_BEFORE;
  return `Here's a draft for: ${task.trim()}\n\nI've kept it short and stuck to what's in your notes.`;
}

async function ask() {
  const input = $("#task-input").value.trim();
  if (!input) { setText("run-hint", "Type what you need first."); return; }

  $("#btn-run").disabled = true;
  setText("run-hint", "Thinking…");
  $("#taught-card").hidden = true;

  try {
    if (state.live) {
      state.run = await api("/api/run", "POST", { loadoutId: me().id, input });
    } else {
      await new Promise((r) => setTimeout(r, 600));
      state.run = {
        id: `run_d${Date.now()}`, input, output: demoAnswer(input), model: me().model,
        stats: { ms: 2380, tokensPerSec: 31.4, encumbranceRatio: roomOf(me()).ratio },
      };
    }
    showAnswer();
    setText("run-hint", "");
  } catch (e) {
    setText("run-hint", e.message);
  } finally {
    $("#btn-run").disabled = false;
  }
}

function showAnswer() {
  const r = state.run;
  $("#btn-copy").textContent = "Copy";
  $("#answer-card").hidden = false;
  $("#answer-text").hidden = false;
  $("#answer-text").textContent = r.output || "(it didn't say anything)";
  $("#answer-edit").hidden = true;
  $("#judge-bar").hidden = false;
  $("#fix-bar").hidden = true;
  setText("run-nerd", `${r.stats.ms} ms · ${r.stats.tokensPerSec.toFixed(1)} tok/s · ${r.model}`);
}

function startFix() {
  $("#answer-text").hidden = true;
  $("#answer-edit").hidden = false;
  $("#answer-edit").value = state.run.output;
  $("#judge-bar").hidden = true;
  $("#fix-bar").hidden = false;
  $("#answer-edit").focus();
}

async function teach(kind, corrected, source = "explicit") {
  const r = state.run;
  let lesson;

  if (state.live) {
    try {
      lesson = await api("/api/capture", "POST", { runId: r.id, kind, source, ...(corrected ? { correctedOutput: corrected } : {}) });
      Object.assign(state, await api("/api/state"));
    } catch (e) {
      setText("run-hint", e.message);
      return;
    }
  } else {
    const assertions =
      kind === "edit" ? assertionsFromEdit(r.output, corrected)
      // Mirrors src/capture.ts: an inferred accept keeps the example but mines
      // no rules, because copying does not mean every phrase was required.
      : kind === "accept" ? (source === "implicit" ? [] : assertionsFromAccept(r.output))
      : assertionsFromReject(r.output);
    lesson = {
      id: `case_d${Date.now()}`, createdAt: new Date().toISOString(),
      title: r.input.split("\n")[0].slice(0, 90), input: r.input, loadoutId: me().id,
      reference: kind === "edit" ? corrected : kind === "accept" ? r.output : "",
      origin: { runId: r.id, verdict: kind, model: r.model, source },
      assertions, graders: kind === "reject" ? ["assertions"] : ["assertions", "judge"], tags: [],
    };
    state.cases.push(lesson);
  }

  $("#answer-card").hidden = true;
  $("#taught-card").hidden = false;
  setText(
    "taught-sub",
    source === "implicit" ? "You copied it, so it's kept as an example of a good answer. It won't turn that into hard rules — for those, tell it what to change."
    : kind === "edit" ? "Your changes turned into these rules."
    : kind === "accept" ? "Kept as an example of a good answer."
    : "Noted as something it shouldn't say again.",
  );
  $("#taught-rules").innerHTML = lesson.assertions.length
    ? lesson.assertions.map((a, i) => ruleHtml(a, i)).join("")
    : `<li><p class="empty">${
        source === "implicit"
          ? "The answer is saved as an example. Every brain you try gets compared against it."
          : "Nothing specific enough to turn into a rule this time — but the example is saved."
      }</p></li>`;

  state.run = null;
  $("#task-input").value = "";
  renderLearned();
  renderTop();
}

// ── the upgrade moment ────────────────────────────────────────────────────────

const REMEMBERED = 0.8;

/** Whole sentences, so the caller never has to glue fragments together. */
function speedSentence(now, before) {
  // Both sides need a real measurement; a sub-millisecond run reports zero.
  if (!(before >= 1) || !(now >= 1)) return "";
  const k = now / before;
  if (k >= 1.8) return "It's about twice as fast as the one you're using.";
  if (k >= 1.25) return "It's noticeably faster than the one you're using.";
  if (k <= 0.55) return "It's around half the speed of the one you're using.";
  if (k <= 0.8) return "It's noticeably slower than the one you're using.";
  return "It runs at about the same speed.";
}

async function tryBrain(model) {
  if (!model) { setText("try-hint", "Pick one, or type a name."); return; }
  if (!state.cases.length) { setText("try-hint", "Teach it something first — there's nothing to check against yet."); return; }

  $("#btn-try").disabled = true;
  const n = state.cases.length;
  setText("try-hint", `Checking ${n} thing${n === 1 ? "" : "s"} you've taught it…`);

  try {
    let replay;
    if (state.live) {
      replay = await api("/api/replay", "POST", { model });
      Object.assign(state, await api("/api/state"));
      replay = state.replays.at(-1);
    } else {
      await new Promise((r) => setTimeout(r, 900));
      const { scores, speed } = demoTrial(model, n);
      replay = {
        id: `rep_d${Date.now()}`, createdAt: new Date().toISOString(), model, loadoutId: me().id,
        results: state.cases.map((c, i) => ({ caseId: c.id, title: c.title, score: scores[i], output: "", graders: [], ms: 1800, tokensPerSec: speed })),
        summary: {
          cases: n, scored: n, meanScore: scores.reduce((a, b) => a + b, 0) / n,
          medianTokensPerSec: speed, failures: 0,
        },
      };
      state.replays.push(replay);
    }
    state.lastTry = replay;
    setText("try-hint", "");
    renderTryResult();
  } catch (e) {
    setText("try-hint", e.message);
  } finally {
    $("#btn-try").disabled = false;
  }
}

function renderTryResult() {
  const r = state.lastTry;
  const el = $("#try-result");
  if (!r) { el.innerHTML = ""; return; }

  const l = me();
  const brain = brainFor(r.model);
  const kept = r.results.filter((x) => x.score >= REMEMBERED);
  const lost = r.results.filter((x) => x.score < REMEMBERED);
  const total = r.results.length;

  // Compare against the best run of what they are using now.
  const mine = state.replays
    .filter((x) => x.model === l.model && x.id !== r.id)
    .sort((a, b) => b.summary.meanScore - a.summary.meanScore)[0];

  const delta = mine ? r.summary.meanScore - mine.summary.meanScore : null;
  const mood = delta === null ? "same" : delta >= 0.05 ? "better" : delta <= -0.05 ? "worse" : "same";

  const headline =
    delta === null
      ? `${brain.name} remembers ${kept.length} of the ${total}.`
      : mood === "better"
        ? `${brain.name} is better than what you're using.`
        : mood === "worse"
          ? `${brain.name} isn't as good as what you're using.`
          : `${brain.name} is about the same as what you're using.`;

  const speed = mine ? speedSentence(r.summary.medianTokensPerSec, mine.summary.medianTokensPerSec) : "";

  el.innerHTML = `<div class="card verdict-card is-${mood}">
    <p class="verdict-big">${esc(headline)}</p>

    <div class="score-line">
      <span class="score-count">Remembers ${kept.length} of the ${total} thing${total === 1 ? "" : "s"} you taught it</span>
      <span class="nerd-only mono">${(r.summary.meanScore * 100).toFixed(1)}% mean · ${r.summary.medianTokensPerSec.toFixed(1)} tok/s · ${esc(r.model)}</span>
    </div>
    <div class="pips">${r.results.map((x) => `<span class="pip-box ${x.score >= REMEMBERED ? "ok" : "no"}" title="${esc(x.title)}"></span>`).join("")}</div>

    ${speed ? `<p class="speed-note">${esc(speed)}</p>` : ""}

    ${lost.length ? `<div class="forgot">
      <span class="forgot-head">It forgot ${lost.length === 1 ? "this" : "these"}:</span>
      ${lost.map((x) => `<span class="forgot-item">${esc(x.title)}</span>`).join("")}
    </div>` : ""}

    <div class="verdict-acts">
      <button class="btn btn-go" data-switch="${esc(r.model)}">Switch to it</button>
      <button class="btn" data-switch-cancel>Stay where I am</button>
    </div>
    <p class="taught-foot">Switching keeps everything you've taught it. You can always switch back.</p>
  </div>`;
}

// ── making it better, on its own ──────────────────────────────────────────────

/**
 * A worked tuning pass for the demo, shaped like a real one: a change that
 * plainly wins, a change that costs nothing and frees room, and a small
 * settings win — because those are the three kinds of answer the engine
 * actually returns.
 */
function demoTuneResult() {
  const total = state.cases.length;
  return {
    baseline: { mean: 0.74, remembered: Math.max(0, total - 1), total, tokensPerSec: 31.4 },
    tried: 7,
    cases: total,
    findings: [
      {
        kind: "brain",
        label: "Switch to New and fast",
        reason: "A different brain, checked against everything you've taught this one.",
        outcome: `remembers 1 more of the things you taught it, and is 2.4× faster.`,
        delta: 0.18, remembered: total, total, speedRatio: 2.4,
        patch: { model: "deepseek-v4-flash" },
      },
      {
        kind: "ability",
        label: 'Drop "Search my files"',
        reason: "It has never been used on any task you've given it, and it costs 1.9% of its room every single time.",
        outcome: "remembers all the same things, with more room left over to think.",
        delta: 0, remembered: Math.max(0, total - 1), total, speedRatio: 1.05,
        patch: { tools: ["read_file"] },
      },
      {
        kind: "variation",
        label: "Make it more predictable",
        reason: "Same answer every time for the same question. Usually helps on factual work.",
        outcome: "remembers the same things, more consistently worded.",
        delta: 0.06, remembered: Math.max(0, total - 1), total, speedRatio: 1,
        patch: { params: { temperature: 0 } },
      },
    ],
  };
}

function tuneScopeNote() {
  const n = state.cases.length;
  if (!n) return "Teach it something first — there's nothing to measure a change against yet.";
  return `It'll try around 7 different setups against your ${n} lesson${n === 1 ? "" : "s"}, one at a time. This takes a while — you can close this and come back.`;
}

async function startTuning() {
  if (!state.cases.length) { setText("tune-hint", "Teach it something first."); return; }

  $("#tune-start").hidden = true;
  $("#tune-working").hidden = false;
  $("#tune-results").innerHTML = "";
  state.tuneResult = null;
  setText("tune-hint", "");

  if (!state.live) {
    // Walk the same progress states the real job reports.
    const steps = ["Checking how your current setup does", 'Drop "Search my files"', "Switch to New and fast", "Make it more predictable", "Checking whether those changes work together"];
    for (let i = 0; i < steps.length; i++) {
      showTuneProgress({ done: i, total: steps.length, note: steps[i] });
      await new Promise((r) => setTimeout(r, 550));
    }
    state.tuneResult = demoTuneResult();
    finishTuning();
    return;
  }

  try {
    const models = BRAINS.map((b) => b.id).filter((id) => id !== me().model);
    state.tuneJob = await api("/api/tune", "POST", { loadoutId: me().id, candidateModels: models });
    pollTuning();
  } catch (e) {
    setText("tune-hint", e.message);
    $("#tune-start").hidden = false;
    $("#tune-working").hidden = true;
  }
}

function showTuneProgress(p) {
  setText("tune-note", p.note || "Working…");
  $("#tune-fill").style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
}

function pollTuning() {
  clearInterval(state.poller);
  state.poller = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${state.tuneJob.id}`);
      state.tuneJob = job;
      showTuneProgress(job.progress);

      if (job.status !== "running") {
        clearInterval(state.poller);
        state.poller = null;
        if (job.status === "failed") {
          setText("tune-hint", job.error ?? "It couldn't finish.");
          $("#tune-start").hidden = false;
          $("#tune-working").hidden = true;
          return;
        }
        state.tuneResult = job.result ?? null;
        Object.assign(state, await api("/api/state"));
        finishTuning();
      }
    } catch (e) {
      clearInterval(state.poller);
      state.poller = null;
      setText("tune-hint", e.message);
      $("#tune-start").hidden = false;
      $("#tune-working").hidden = true;
    }
  }, 900);
}

function finishTuning() {
  $("#tune-working").hidden = true;
  $("#tune-start").hidden = false;
  renderTuneResults();
  renderTop();
}

function liveFindings() {
  const r = state.tuneResult;
  if (!r) return [];
  const all = [...(r.combined ? [r.combined] : []), ...r.findings];
  return all.filter((f) => !state.dismissed.has(f.label));
}

function renderTuneResults() {
  const el = $("#tune-results");
  const r = state.tuneResult;
  if (!r) { el.innerHTML = ""; return; }

  const findings = liveFindings();
  if (!findings.length) {
    el.innerHTML = `<div class="card">
      <h2 class="card-title">Nothing worth changing</h2>
      <p class="card-sub">It tried ${r.tried} different setups against your ${r.cases} lesson${r.cases === 1 ? "" : "s"} and couldn't beat what you already have. That's a good result.</p>
    </div>`;
    return;
  }

  const unattended = r.trigger && r.trigger !== "asked";
  el.innerHTML = `<div class="card ${unattended && r.unseen ? "away" : ""}">
    ${unattended ? `<span class="away-flag">Found while you were away · ${whenText(r.createdAt)}</span>` : ""}
    <h2 class="card-title">It found ${findings.length} thing${findings.length === 1 ? "" : "s"}</h2>
    <p class="card-sub">Each one was checked against every lesson you've taught it. Nothing has been changed yet.</p>
    <p class="baseline-note">Right now it remembers ${r.baseline.remembered} of ${r.baseline.total}<span class="nerd-only mono"> · mean ${(r.baseline.mean * 100).toFixed(1)}% · ${r.baseline.tokensPerSec.toFixed(1)} tok/s · ${r.tried} setups tried</span></p>
    ${r.skipped ? `<p class="baseline-note">It stopped ${r.skipped} short of trying everything, to stay inside its budget for this pass.</p>` : ""}
  </div>
  <div class="found">${findings.map(findingHtml).join("")}</div>`;

  // Reading it counts as seeing it.
  if (unattended && r.unseen && state.live) {
    r.unseen = false;
    api(`/api/findings/${r.id}`, "PATCH", { unseen: false }).catch(() => {});
  }
}

function findingHtml(f, i) {
  const free = f.delta < 0.04;
  const ratio = Number.isFinite(f.speedRatio) ? f.speedRatio : 1;
  const gain = free
    ? ratio >= 1.25 ? `${ratio.toFixed(1)}× faster` : "costs nothing"
    : `+${Math.round(f.delta * 100)} pts`;

  return `<article class="finding ${free ? "is-free" : ""}" style="--i:${i}">
    <span class="finding-label">${esc(f.label)}</span>
    <span class="finding-gain">${esc(gain)}</span>
    <span class="finding-why">${esc(f.reason)}</span>
    <span class="finding-outcome">Tried it: ${esc(f.outcome)}</span>
    <span class="finding-acts">
      <button class="btn btn-go" data-apply="${esc(f.label)}">Do it</button>
      <button class="btn" data-dismiss="${esc(f.label)}">No thanks</button>
      <span class="nerd-only mono">${esc(JSON.stringify(f.patch))}</span>
    </span>
  </article>`;
}

async function applyFinding(label) {
  const f = liveFindings().find((x) => x.label === label);
  if (!f) return;
  await change(f.patch);
  state.dismissed.add(label);
  renderTuneResults();
  renderTryList();
  renderTop();
}

// ── events ────────────────────────────────────────────────────────────────────

$$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

$("#nerd-toggle").addEventListener("change", (e) => {
  document.body.classList.toggle("show-nerd", e.target.checked);
});

$("#brain-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-brain]");
  if (!b) return;
  const chosen = BRAINS.find((x) => x.id === b.dataset.brain);
  change({ model: b.dataset.brain, ...(chosen?.context ? { contextWindow: chosen.context } : {}) });
  renderTryList();
});

$("#try-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-brain]");
  if (b) tryBrain(b.dataset.brain);
});

$("#ability-list").addEventListener("click", (e) => {
  const name = e.target.dataset?.ability;
  if (!name) return;
  const l = me();
  change({ tools: l.tools.includes(name) ? l.tools.filter((t) => t !== name) : [...l.tools, name] });
});

$("#note-list").addEventListener("click", (e) => {
  const path = e.target.dataset?.forget;
  if (!path) return;
  change({ memory: me().memory.filter((m) => m !== path) });
});

$("#note-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = $("#note-input").value.trim();
  if (!path) return;
  const l = me();
  if (!l.memory.includes(path)) change({ memory: [...l.memory, path] });
  $("#note-input").value = "";
});

$("#f-system").addEventListener("input", () => { me().systemPrompt = $("#f-system").value; renderAssistant(); });
$("#f-system").addEventListener("change", (e) => change({ systemPrompt: e.target.value }));
$("#f-model").addEventListener("change", (e) => { change({ model: e.target.value }); renderTryList(); });
$("#f-baseurl").addEventListener("change", (e) => change({ baseUrl: e.target.value }));
$("#f-context").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  if (Number.isFinite(n) && n > 0) change({ contextWindow: n });
});

$("#btn-run").addEventListener("click", ask);
$("#task-input").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") ask(); });

$("#judge-bar").addEventListener("click", (e) => {
  const v = e.target.dataset?.verdict;
  if (!v) return;
  if (v === "edit") startFix();
  else teach(v);
});
$("#btn-save-fix").addEventListener("click", () => {
  const corrected = $("#answer-edit").value;
  if (corrected.trim() === state.run.output.trim()) teach("accept");
  else teach("edit", corrected);
});
$("#btn-cancel-fix").addEventListener("click", showAnswer);
$("#btn-ask-again").addEventListener("click", () => {
  $("#taught-card").hidden = true;
  $("#task-input").focus();
});

/**
 * Copying is the cheapest true signal there is.
 *
 * Someone who pastes an answer into an email has told you it was good, without
 * being asked and without stopping what they were doing. It is weaker evidence
 * than "yes, that's right", so it is stored as implicit and labelled that way
 * wherever it shows up.
 */
$("#btn-copy").addEventListener("click", async () => {
  const text = state.run?.output ?? "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused; the signal is still real.
  }
  $("#btn-copy").textContent = "Copied";
  teach("accept", undefined, "implicit");
});

$("#learned-list").addEventListener("click", (e) => {
  const edit = e.target.dataset?.edit;
  if (edit) { state.editing = state.editing === edit ? null : edit; renderLearned(); return; }

  const drop = e.target.dataset?.drop;
  if (drop) { dropRule(drop, Number(e.target.dataset.index)); return; }

  const forget = e.target.dataset?.forgetLesson;
  if (forget) forgetLesson(forget);
});

$("#set-autotune").addEventListener("change", (e) => saveSettings({ autoTune: e.target.checked }));
$("#set-watch").addEventListener("change", (e) => saveSettings({ watchForNewModels: e.target.checked }));

$("#btn-try").addEventListener("click", () => tryBrain($("#try-model").value.trim()));

$("#btn-health").addEventListener("click", async () => {
  setText("health-hint", "Looking…");
  await checkHealth();
  setText("health-hint", "");
  renderHealth();
  renderAssistant();
  renderTryList();
});

$("#btn-tune").addEventListener("click", startTuning);
$("#btn-tune-stop").addEventListener("click", async () => {
  if (state.live && state.tuneJob) await api(`/api/jobs/${state.tuneJob.id}`, "DELETE").catch(() => {});
  clearInterval(state.poller);
  state.poller = null;
  $("#tune-working").hidden = true;
  $("#tune-start").hidden = false;
});

$("#tune-results").addEventListener("click", (e) => {
  const apply = e.target.dataset?.apply;
  if (apply) { applyFinding(apply); return; }
  const dismiss = e.target.dataset?.dismiss;
  if (dismiss) { state.dismissed.add(dismiss); renderTuneResults(); renderTop(); }
});

$("#try-result").addEventListener("click", (e) => {
  const model = e.target.dataset?.switch;
  if (model) {
    change({ model });
    renderTryList();
    state.lastTry = null;
    $("#try-result").innerHTML = "";
    show("assistant");
    return;
  }
  if (e.target.hasAttribute?.("data-switch-cancel")) {
    state.lastTry = null;
    $("#try-result").innerHTML = "";
  }
});

boot();
