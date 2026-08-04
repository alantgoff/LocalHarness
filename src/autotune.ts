import { computeEncumbrance } from "./loadout.js";
import { gradeCase, judgeFromEnv, type JudgeConfig } from "./grade.js";
import { executeRun } from "./runner.js";
import { cases as caseStore, runs as runStore } from "./store.js";
import { REGISTRY } from "./tools.js";
import type { EvalCase, Loadout } from "./types.js";

/**
 * The part that works while nobody is watching.
 *
 * Once there is a record of what good looks like for one specific person, the
 * setup stops being a matter of taste and becomes a search problem. Which
 * brain, which abilities, how much variation — all of it can be tried and
 * scored without asking the user anything, because the answer key already
 * exists.
 *
 * Two rules this follows, both of which exist to keep it trustworthy:
 *
 *   1. Never change anything. It reports findings; a person applies them.
 *   2. Never report a number without a reason. "12% better" is a result
 *      nobody can check. "It never used 'Search my files' on any of these
 *      tasks, and dropping it freed 2% of its room" is one they can.
 */

/** A score at or above this counts as "remembered" — matches the UI. */
const REMEMBERED = 0.8;

/** Below this, a change isn't worth a person's attention. */
const MIN_DELTA = 0.04;

export interface Candidate {
  /** Shown as the headline. Written for a person, not a changelog. */
  label: string;
  /** Why it was worth trying at all. */
  reason: string;
  patch: Partial<Loadout>;
  kind: "brain" | "ability" | "variation" | "notes";
}

export interface Scored {
  mean: number;
  remembered: number;
  total: number;
  tokensPerSec: number;
  /** Which abilities the model actually reached for, across the whole suite. */
  used: Set<string>;
}

export interface Finding extends Candidate {
  score: number;
  delta: number;
  remembered: number;
  total: number;
  tokensPerSec: number;
  speedRatio: number;
  /** Fills in after scoring, when the real effect is known. */
  outcome: string;
}

export interface TuneResult {
  baseline: { mean: number; remembered: number; total: number; tokensPerSec: number };
  findings: Finding[];
  /** Every candidate tried, so nothing is silently dropped. */
  tried: number;
  cases: number;
  combined?: Finding;
}

export interface TuneOptions {
  loadout: Loadout;
  /** Brains worth trying. The caller knows what is installed; this does not. */
  candidateModels?: string[];
  maxCandidates?: number;
  cwd?: string;
  onProgress?: (done: number, total: number, note: string) => void;
  signal?: { aborted: boolean };
}

/** Run the whole suite under one configuration. */
async function scoreConfig(
  loadout: Loadout,
  evalCases: EvalCase[],
  judge: JudgeConfig | undefined,
  cwd: string | undefined,
): Promise<Scored> {
  let total = 0;
  let remembered = 0;
  const speeds: number[] = [];
  const used = new Set<string>();

  for (const c of evalCases) {
    const run = await executeRun(loadout, c.input, { ...(cwd ? { cwd } : {}) });
    for (const call of run.toolCalls) used.add(call.name);
    speeds.push(run.stats.tokensPerSec);

    const graded = run.error && !run.output ? { score: 0 } : await gradeCase(c, run.output, judge);
    total += graded.score;
    if (graded.score >= REMEMBERED) remembered++;
  }

  speeds.sort((a, b) => a - b);
  return {
    mean: evalCases.length ? total / evalCases.length : 0,
    remembered,
    total: evalCases.length,
    tokensPerSec: speeds.length ? (speeds[Math.floor(speeds.length / 2)] ?? 0) : 0,
    used,
  };
}

/**
 * What is worth trying, given this setup and what the runs already show.
 *
 * The ordering matters: cheap, high-confidence changes first, so a tuning pass
 * that gets cut short has still done the most valuable work.
 */
export function proposeCandidates(loadout: Loadout, opts: TuneOptions): Candidate[] {
  const out: Candidate[] = [];
  const encumbrance = computeEncumbrance(loadout, opts.cwd);

  // Which abilities has this setup ever actually reached for? Past runs are
  // free evidence, and an unused ability is pure cost.
  const everUsed = new Set<string>();
  for (const run of runStore.list()) {
    if (run.loadoutId !== loadout.id) continue;
    for (const call of run.toolCalls) everUsed.add(call.name);
  }

  for (const name of loadout.tools) {
    const cost = encumbrance.perTool.find((t) => t.name === name)?.tokens ?? 0;
    const share = ((cost / (loadout.contextWindow || 1)) * 100).toFixed(1);
    out.push({
      kind: "ability",
      label: `Drop "${name}"`,
      reason: everUsed.has(name)
        ? `It costs ${share}% of its room. Worth checking whether it earns that on your work.`
        : `It has never been used on any task you've given it, and it costs ${share}% of its room every single time.`,
      patch: { tools: loadout.tools.filter((t) => t !== name) },
    });
  }

  for (const name of Object.keys(REGISTRY)) {
    if (loadout.tools.includes(name)) continue;
    out.push({
      kind: "ability",
      label: `Add "${name}"`,
      reason: "It isn't switched on. Some tasks may be failing for want of it.",
      patch: { tools: [...loadout.tools, name] },
    });
  }

  for (const model of opts.candidateModels ?? []) {
    if (model === loadout.model) continue;
    out.push({
      kind: "brain",
      label: `Switch to ${model}`,
      reason: "A different brain, checked against everything you've taught this one.",
      patch: { model },
    });
  }

  const temp = loadout.params.temperature ?? 0.2;
  for (const t of [0, 0.4].filter((x) => Math.abs(x - temp) > 0.05)) {
    out.push({
      kind: "variation",
      label: t === 0 ? "Make it more predictable" : "Let it vary its wording more",
      reason:
        t === 0
          ? "Same answer every time for the same question. Usually helps on factual work."
          : "More variety in phrasing. Sometimes helps when answers feel stilted.",
      patch: { params: { ...loadout.params, temperature: t } },
    });
  }

  for (const path of loadout.memory) {
    const note = encumbrance.perMemory.find((m) => m.path === path);
    if (note?.missing) continue;
    const shareOf = ((note?.tokens ?? 0) / (loadout.contextWindow || 1)) * 100;
    // Only worth questioning a note that is actually expensive.
    if (shareOf < 3) continue;
    out.push({
      kind: "notes",
      label: `Stop always reading "${path}"`,
      reason: `It takes ${shareOf.toFixed(1)}% of its room on every single answer. Worth knowing if it pays for itself.`,
      patch: { memory: loadout.memory.filter((m) => m !== path) },
    });
  }

  return out;
}

function apply(loadout: Loadout, patch: Partial<Loadout>): Loadout {
  return { ...loadout, ...patch };
}

/**
 * Only compare speeds when both sides were actually measured. A run that
 * finishes in under a millisecond reports zero tokens per second, and dividing
 * by that produces "Infinity× slower", which is worse than saying nothing.
 */
function speedRatioOf(base: Scored, got: Scored): number {
  if (base.tokensPerSec < 1 || got.tokensPerSec < 1) return 1;
  return got.tokensPerSec / base.tokensPerSec;
}

/** Turn a measured result into a sentence a person can act on. */
function describeOutcome(c: Candidate, base: Scored, got: Scored): string {
  const gained = got.remembered - base.remembered;
  const faster = speedRatioOf(base, got);
  const bits: string[] = [];

  if (gained > 0) bits.push(`remembers ${gained} more of the things you taught it`);
  else if (gained < 0) bits.push(`forgets ${-gained} it used to get right`);
  else if (got.remembered > 0) bits.push(`remembers the same ${got.remembered}`);
  else if (got.mean > base.mean) bits.push("gets closer on your lessons, though it still doesn't fully nail any of them");
  else bits.push("performs about the same");

  if (faster >= 1.25) bits.push(`and is ${faster.toFixed(1)}× faster`);
  else if (faster <= 0.8) bits.push(`but is ${(1 / faster).toFixed(1)}× slower`);

  if (c.kind === "ability" && c.label.startsWith("Drop")) bits.push("with more room left over to think");

  return `${bits.join(", ")}.`;
}

/**
 * One pass: score where things stand, try each candidate, keep what helped,
 * then check whether the winners still work when stacked together.
 *
 * Greedy rather than exhaustive on purpose. An exhaustive search over this
 * space costs hundreds of model calls to find something marginally better than
 * what one careful pass finds, and this has to be able to finish overnight on
 * a laptop.
 */
export async function tune(opts: TuneOptions): Promise<TuneResult> {
  const evalCases = caseStore.list().filter((c) => c.loadoutId === opts.loadout.id);
  if (!evalCases.length) {
    throw new Error("nothing to tune against yet — teach it something first");
  }

  const judge = judgeFromEnv();
  const candidates = proposeCandidates(opts.loadout, opts).slice(0, opts.maxCandidates ?? 12);
  const steps = candidates.length + 1;
  let done = 0;

  const report = (note: string) => opts.onProgress?.(done, steps, note);

  report("Checking how your current setup does");
  const base = await scoreConfig(opts.loadout, evalCases, judge, opts.cwd);
  done++;

  const findings: Finding[] = [];

  for (const c of candidates) {
    if (opts.signal?.aborted) break;
    report(c.label);

    const got = await scoreConfig(apply(opts.loadout, c.patch), evalCases, judge, opts.cwd);
    done++;

    const delta = got.mean - base.mean;
    if (delta >= MIN_DELTA || (Math.abs(delta) < MIN_DELTA && isFreeWin(c, base, got))) {
      findings.push({
        ...c,
        score: got.mean,
        delta,
        remembered: got.remembered,
        total: got.total,
        tokensPerSec: got.tokensPerSec,
        speedRatio: speedRatioOf(base, got),
        outcome: describeOutcome(c, base, got),
      });
    }
  }

  findings.sort((a, b) => b.delta - a.delta);

  // Stack the winners and verify. Changes that each help alone can fight when
  // combined, and reporting an unverified stack would be exactly the kind of
  // confident-but-wrong advice this is supposed to replace.
  let combined: Finding | undefined;
  const stackable = findings.filter((f) => f.delta >= MIN_DELTA);
  if (stackable.length >= 2 && !opts.signal?.aborted) {
    report("Checking whether those changes work together");
    const merged = stackable.reduce((l, f) => apply(l, f.patch), opts.loadout);
    const got = await scoreConfig(merged, evalCases, judge, opts.cwd);
    const delta = got.mean - base.mean;

    if (delta > (stackable[0]?.delta ?? 0)) {
      combined = {
        kind: "brain",
        label: "Apply all of the above together",
        reason: `Each change helps on its own. Together they were checked against all ${evalCases.length} of your ${evalCases.length === 1 ? "lesson" : "lessons"} as well.`,
        patch: stackable.reduce<Partial<Loadout>>((p, f) => ({ ...p, ...f.patch }), {}),
        score: got.mean,
        delta,
        remembered: got.remembered,
        total: got.total,
        tokensPerSec: got.tokensPerSec,
        speedRatio: speedRatioOf(base, got),
        outcome: describeOutcome({ kind: "brain", label: "", reason: "", patch: {} }, base, got),
      };
    }
  }

  return {
    baseline: { mean: base.mean, remembered: base.remembered, total: base.total, tokensPerSec: base.tokensPerSec },
    findings,
    tried: candidates.length,
    cases: evalCases.length,
    ...(combined ? { combined } : {}),
  };
}

/**
 * Some changes are worth reporting even when the score does not move: dropping
 * an ability that costs room and changes nothing is a real win, just not a
 * scoring one.
 */
function isFreeWin(c: Candidate, base: Scored, got: Scored): boolean {
  if (c.kind !== "ability" || !c.label.startsWith("Drop")) return false;
  if (got.remembered < base.remembered) return false;
  const name = c.label.match(/"([^"]+)"/)?.[1];
  return !!name && !base.used.has(name);
}
