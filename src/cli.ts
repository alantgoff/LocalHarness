#!/usr/bin/env node
import { createLoadout, describeEncumbrance, DEFAULT_BASE_URL } from "./loadout.js";
import { promoteToCase, promptVerdict, SkipCapture } from "./capture.js";
import { compareReplays, runReplay } from "./replay.js";
import { executeRun } from "./runner.js";
import { cases, ensureHome, homeDir, isInitialized, loadouts, replays, runs } from "./store.js";
import { toolNames } from "./tools.js";

const USAGE = `localharness — build a harness for an open-weight model, and grow an eval suite by using it.

  lh init                              create .localharness/ and a starter loadout
  lh loadout list                      list loadouts with their context cost
  lh loadout show <ref>                full encumbrance breakdown
  lh loadout new <name> [opts]         create a loadout
  lh loadout equip <ref> <tool>...     add tools, showing what they cost
  lh loadout pin <ref> <file>...       pin memory files into every prompt

  lh run "<task>" [opts]               run a task, then capture your verdict
  lh cases list                        captured eval cases
  lh cases show <id>                   one case, with its assertions
  lh replay --model <m> [opts]         replay every case against a model
  lh report [replayId]                 show a replay
  lh compare <replayA> <replayB>       what a model swap actually changed

options
  --loadout <ref>     loadout id or name (defaults to the only one, if unambiguous)
  --model <name>      override the model
  --base-url <url>    override the endpoint (mock:// works offline)
  --tag <tag>         tag a captured case, or filter a replay
  --verdict <a|e|r>   non-interactive capture
  --yes               accept without prompting (same as --verdict a)

environment
  LOCALHARNESS_HOME             where data lives (default ./.localharness)
  LOCALHARNESS_BASE_URL         default endpoint (default ${DEFAULT_BASE_URL})
  LOCALHARNESS_API_KEY          bearer token for hosted endpoints
  LOCALHARNESS_JUDGE_MODEL      enables the judge grader
  LOCALHARNESS_JUDGE_BASE_URL   endpoint for the judge

tools available to equip: ${toolNames().join(", ")}
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function requireInit(): void {
  if (!isInitialized()) {
    throw new Error("not initialized here — run `lh init` first");
  }
}

/** Resolve a loadout from --loadout, or the only one if there is no ambiguity. */
function resolveLoadout(args: Args) {
  const ref = flagString(args, "loadout");
  if (ref) {
    const found = loadouts.find(ref);
    if (!found) throw new Error(`no such loadout: ${ref}`);
    return found;
  }
  const all = loadouts.list();
  if (all.length === 1) return all[0]!;
  if (all.length === 0) throw new Error("no loadouts yet — run `lh init` or `lh loadout new <name>`");
  throw new Error(`several loadouts exist; pass --loadout <name>. Have: ${all.map((l) => l.name).join(", ")}`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// --- commands ---------------------------------------------------------------

function cmdInit(): void {
  const root = ensureHome();
  if (loadouts.list().length === 0) {
    const starter = createLoadout({
      name: "default",
      systemPrompt:
        "You are a careful assistant. Answer directly, without preamble. " +
        "If you are unsure, say so rather than guessing.",
      tools: [],
      contextWindow: 8192,
    });
    loadouts.save(starter);
    process.stdout.write(`created loadout "${starter.name}" (${starter.id})\n`);
  }
  process.stdout.write(`initialized ${root}\n\nnext: lh run "some task you actually have"\n`);
}

function cmdLoadoutList(): void {
  requireInit();
  const all = loadouts.list();
  if (!all.length) {
    process.stdout.write("no loadouts. `lh loadout new <name>`\n");
    return;
  }
  for (const l of all) {
    process.stdout.write(`${describeEncumbrance(l)}\n\n`);
  }
}

function cmdLoadoutShow(args: Args): void {
  requireInit();
  const ref = args.positional[2];
  const l = ref ? loadouts.find(ref) : resolveLoadout(args);
  if (!l) throw new Error(`no such loadout: ${ref}`);
  process.stdout.write(`${describeEncumbrance(l)}\n\nsystem prompt:\n${l.systemPrompt}\n`);
}

function cmdLoadoutNew(args: Args): void {
  requireInit();
  const name = args.positional[2];
  if (!name) throw new Error("usage: lh loadout new <name> [--model m] [--base-url u] [--context N]");

  const contextRaw = flagString(args, "context");
  const l = createLoadout({
    name,
    ...(flagString(args, "model") ? { model: flagString(args, "model")! } : {}),
    ...(flagString(args, "base-url") ? { baseUrl: flagString(args, "base-url")! } : {}),
    ...(contextRaw ? { contextWindow: Number(contextRaw) } : {}),
    ...(flagString(args, "system") ? { systemPrompt: flagString(args, "system")! } : {}),
  });
  loadouts.save(l);
  process.stdout.write(`${describeEncumbrance(l)}\n`);
}

function cmdLoadoutEquip(args: Args): void {
  requireInit();
  const ref = args.positional[2];
  const tools = args.positional.slice(3);
  if (!ref || !tools.length) throw new Error("usage: lh loadout equip <ref> <tool>...");

  const l = loadouts.find(ref);
  if (!l) throw new Error(`no such loadout: ${ref}`);

  const unknown = tools.filter((t) => !toolNames().includes(t));
  if (unknown.length) {
    throw new Error(`unknown tool(s): ${unknown.join(", ")}. Available: ${toolNames().join(", ")}`);
  }

  l.tools = [...new Set([...l.tools, ...tools])];
  loadouts.save(l);
  process.stdout.write(`${describeEncumbrance(l)}\n`);
}

function cmdLoadoutPin(args: Args): void {
  requireInit();
  const ref = args.positional[2];
  const files = args.positional.slice(3);
  if (!ref || !files.length) throw new Error("usage: lh loadout pin <ref> <file>...");

  const l = loadouts.find(ref);
  if (!l) throw new Error(`no such loadout: ${ref}`);
  l.memory = [...new Set([...l.memory, ...files])];
  loadouts.save(l);
  process.stdout.write(`${describeEncumbrance(l)}\n`);
}

async function cmdRun(args: Args): Promise<void> {
  requireInit();
  const input = args.positional[1];
  if (!input) throw new Error('usage: lh run "<task>"');

  const loadout = resolveLoadout(args);
  const model = flagString(args, "model") ?? loadout.model;
  process.stdout.write(`${loadout.name} / ${model}\n\n`);

  const run = await executeRun(loadout, input, {
    model,
    ...(flagString(args, "base-url") ? { baseUrl: flagString(args, "base-url")! } : {}),
    onEvent: (line) => process.stdout.write(`${line}\n`),
  });
  runs.save(run);

  process.stdout.write(`${run.output || "(no output)"}\n`);
  if (run.error) process.stdout.write(`\n! ${run.error}\n`);
  process.stdout.write(
    `\n[${run.stats.ms}ms, ~${run.stats.tokensPerSec.toFixed(1)} tok/s, ` +
      `harness used ${pct(run.stats.encumbranceRatio)} of context]\n`,
  );

  // Non-interactive capture keeps this usable from scripts and CI.
  const verdictFlag = flagString(args, "verdict") ?? (args.flags.yes ? "a" : undefined);
  let verdict;
  if (verdictFlag) {
    const kind = { a: "accept", e: "edit", r: "reject" }[verdictFlag[0] ?? ""];
    if (!kind || kind === "edit") {
      throw new Error("--verdict accepts 'a' or 'r'; editing needs the interactive prompt");
    }
    verdict = { kind: kind as "accept" | "reject", at: new Date().toISOString() };
  } else {
    try {
      verdict = await promptVerdict(run);
    } catch (e) {
      if (e instanceof SkipCapture) {
        process.stdout.write(`run saved as ${run.id}, no case captured\n`);
        return;
      }
      throw e;
    }
  }

  const tag = flagString(args, "tag");
  const c = promoteToCase(run, verdict, tag ? [tag] : []);
  process.stdout.write(
    `\ncaptured ${c.id} (${verdict.kind}) with ${c.assertions.length} assertion(s)\n` +
      `total cases: ${cases.list().length}\n`,
  );
}

function cmdCasesList(): void {
  requireInit();
  const all = cases.list();
  if (!all.length) {
    process.stdout.write("no cases yet. Run `lh run \"...\"` and give a verdict.\n");
    return;
  }
  for (const c of all) {
    const tags = c.tags.length ? `  #${c.tags.join(" #")}` : "";
    process.stdout.write(
      `${c.id}  ${c.origin.verdict.padEnd(6)} ${c.assertions.length} assert  ${c.title}${tags}\n`,
    );
  }
  process.stdout.write(`\n${all.length} case(s)\n`);
}

function cmdCasesShow(args: Args): void {
  requireInit();
  const id = args.positional[2];
  if (!id) throw new Error("usage: lh cases show <id>");
  const c = cases.get(id);
  if (!c) throw new Error(`no such case: ${id}`);

  process.stdout.write(`${c.id}  ${c.title}\n`);
  process.stdout.write(`captured from ${c.origin.model} as "${c.origin.verdict}"\n`);
  process.stdout.write(`graders: ${c.graders.join(", ")}\n\ntask:\n${c.input}\n`);
  if (c.reference.trim()) process.stdout.write(`\nreference:\n${c.reference}\n`);
  if (c.antiReference) process.stdout.write(`\nrejected output:\n${c.antiReference}\n`);
  if (c.assertions.length) {
    process.stdout.write(`\nassertions:\n`);
    for (const a of c.assertions) {
      process.stdout.write(`  [${a.source} w${a.weight}] ${a.kind}: ${a.value}\n`);
    }
  }
}

async function cmdReplay(args: Args): Promise<void> {
  requireInit();
  const model = flagString(args, "model");
  if (!model) throw new Error("usage: lh replay --model <name> [--base-url u] [--loadout ref] [--tag t]");

  const tag = flagString(args, "tag");
  const replay = await runReplay({
    model,
    ...(flagString(args, "base-url") ? { baseUrl: flagString(args, "base-url")! } : {}),
    ...(flagString(args, "loadout") ? { loadoutRef: flagString(args, "loadout")! } : {}),
    ...(tag ? { tags: [tag] } : {}),
    onProgress: (done, total, r) => {
      const mark = r.error ? "!" : r.score >= 0.8 ? "+" : r.score >= 0.5 ? "~" : "-";
      process.stdout.write(`  ${mark} [${done}/${total}] ${pct(r.score).padStart(6)}  ${r.title}\n`);
    },
  });

  process.stdout.write(
    `\n${replay.id}\n` +
      `model     ${replay.model}\n` +
      `mean      ${pct(replay.summary.meanScore)} over ${replay.summary.scored} case(s)\n` +
      `speed     ${replay.summary.medianTokensPerSec.toFixed(1)} tok/s median\n` +
      (replay.summary.failures ? `failures  ${replay.summary.failures}\n` : ""),
  );
}

function cmdReport(args: Args): void {
  requireInit();
  const id = args.positional[1];
  const all = replays.list();
  const replay = id ? replays.get(id) : all[all.length - 1];
  if (!replay) throw new Error(id ? `no such replay: ${id}` : "no replays yet");

  process.stdout.write(`${replay.id}  ${replay.model}  ${replay.createdAt}\n\n`);
  for (const r of replay.results) {
    process.stdout.write(`${pct(r.score).padStart(6)}  ${r.title}${r.error ? `  !${r.error}` : ""}\n`);
    for (const g of r.graders) {
      process.stdout.write(`        ${g.skipped ? "skip" : pct(g.score).padStart(6)}  ${g.grader}: ${g.detail}\n`);
    }
  }
  process.stdout.write(
    `\nmean ${pct(replay.summary.meanScore)}  |  ${replay.summary.medianTokensPerSec.toFixed(1)} tok/s median\n`,
  );
}

function cmdCompare(args: Args): void {
  requireInit();
  const [, aId, bId] = args.positional;
  if (!aId || !bId) throw new Error("usage: lh compare <replayA> <replayB>");
  const a = replays.get(aId);
  const b = replays.get(bId);
  if (!a) throw new Error(`no such replay: ${aId}`);
  if (!b) throw new Error(`no such replay: ${bId}`);
  process.stdout.write(`${compareReplays(a, b)}\n`);
}

// --- dispatch ---------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, sub] = args.positional;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return;
    case "init":
      return cmdInit();
    case "where":
      process.stdout.write(`${homeDir()}\n`);
      return;
    case "loadout":
      switch (sub) {
        case undefined:
        case "list":
          return cmdLoadoutList();
        case "show":
          return cmdLoadoutShow(args);
        case "new":
          return cmdLoadoutNew(args);
        case "equip":
          return cmdLoadoutEquip(args);
        case "pin":
          return cmdLoadoutPin(args);
        default:
          throw new Error(`unknown: lh loadout ${sub}`);
      }
    case "run":
      return cmdRun(args);
    case "cases":
      switch (sub) {
        case undefined:
        case "list":
          return cmdCasesList();
        case "show":
          return cmdCasesShow(args);
        default:
          throw new Error(`unknown: lh cases ${sub}`);
      }
    case "replay":
      return cmdReplay(args);
    case "report":
      return cmdReport(args);
    case "compare":
      return cmdCompare(args);
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

// Piping into `head` closes stdout early; that is normal shell usage, not a
// crash worth a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

main().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
