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
  renderAll();
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
  $("#brain-list").innerHTML = BRAINS.map((b) => brainHtml(b, b.id === l.model, "pick")).join("");

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
  return `<li>
    <button class="brain ${current ? "is-on" : ""}" data-brain="${esc(b.id)}" data-action="${action}" ${current && action === "pick" ? "disabled" : ""}>
      <span class="brain-name">${esc(b.name)}${current ? '<span class="badge">using this</span>' : ""}</span>
      <span class="brain-pick">${current ? "" : action === "pick" ? "Use this" : "Test it"}</span>
      <span class="brain-note">${esc(b.note)}</span>
      <span class="brain-needs">${esc(b.needs)}<span class="nerd-only mono"> · ${esc(b.id)}</span></span>
    </button>
  </li>`;
}

function ruleHtml(a, i = 0) {
  const always = a.kind === "contains";
  return `<li class="rule ${always ? "rule-always" : "rule-never"}" style="--i:${i}">
    <span class="rule-kind">${always ? "Always say" : "Never say"}</span>
    <span class="rule-text">${esc(a.value)}</span>
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
  const tagFor = { edit: ["tag-fixed", "you fixed it"], accept: ["tag-kept", "you kept it"], reject: ["tag-wrong", "you said no"] };

  el.innerHTML = state.cases
    .map((c) => {
      const [cls, label] = tagFor[c.origin.verdict] ?? ["", c.origin.verdict];
      return `<article class="card lesson">
        <div class="lesson-head">
          <h2 class="lesson-title">${esc(c.title)}</h2>
        </div>
        <div class="lesson-head">
          <span class="tagline ${cls}">${label}</span>
          <span class="lesson-when">${whenText(c.createdAt)}</span>
        </div>
        <ul class="rules" role="list">${c.assertions.map((a, i) => ruleHtml(a, i)).join("")}</ul>
      </article>`;
    })
    .join("");
}

function renderTryList() {
  const l = me();
  $("#try-list").innerHTML = BRAINS.filter((b) => b.id !== l?.model).map((b) => brainHtml(b, false, "try")).join("");
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

async function teach(kind, corrected) {
  const r = state.run;
  let lesson;

  if (state.live) {
    try {
      lesson = await api("/api/capture", "POST", { runId: r.id, kind, ...(corrected ? { correctedOutput: corrected } : {}) });
      Object.assign(state, await api("/api/state"));
    } catch (e) {
      setText("run-hint", e.message);
      return;
    }
  } else {
    const assertions =
      kind === "edit" ? assertionsFromEdit(r.output, corrected)
      : kind === "accept" ? assertionsFromAccept(r.output)
      : assertionsFromReject(r.output);
    lesson = {
      id: `case_d${Date.now()}`, createdAt: new Date().toISOString(),
      title: r.input.split("\n")[0].slice(0, 90), input: r.input, loadoutId: me().id,
      reference: kind === "edit" ? corrected : kind === "accept" ? r.output : "",
      origin: { runId: r.id, verdict: kind, model: r.model },
      assertions, graders: kind === "reject" ? ["assertions"] : ["assertions", "judge"], tags: [],
    };
    state.cases.push(lesson);
  }

  $("#answer-card").hidden = true;
  $("#taught-card").hidden = false;
  setText(
    "taught-sub",
    kind === "edit" ? "Your changes turned into these rules."
    : kind === "accept" ? "Kept as an example of a good answer."
    : "Noted as something it shouldn't say again.",
  );
  $("#taught-rules").innerHTML = lesson.assertions.length
    ? lesson.assertions.map((a, i) => ruleHtml(a, i)).join("")
    : '<li><p class="empty">Nothing specific enough to turn into a rule this time — but the example is saved.</p></li>';

  state.run = null;
  $("#task-input").value = "";
  renderLearned();
  renderTop();
}

// ── the upgrade moment ────────────────────────────────────────────────────────

const REMEMBERED = 0.8;

/** Whole sentences, so the caller never has to glue fragments together. */
function speedSentence(now, before) {
  if (!before || !now) return "";
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

$("#btn-try").addEventListener("click", () => tryBrain($("#try-model").value.trim()));

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
