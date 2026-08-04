import type { Assertion, CaseStats, EvalCase } from "./types.js";

/**
 * The suite, considered as a measuring instrument rather than a list of tests.
 *
 * Not every lesson is worth the same. One that every model passes tells you
 * nothing about which model to choose — it is a regression guard, not a
 * discriminator. One that no model has ever passed is far more likely to be a
 * rule nobody could satisfy than a failing common to every model ever built.
 * And two lessons that contradict each other guarantee that one of them fails
 * forever, dragging every score down for a reason no number explains.
 *
 * None of this is visible from a mean. All of it changes what the mean means.
 */

/** A score at or above this counts as remembered — matches the UI and tuner. */
export const REMEMBERED = 0.8;

/** Below this many trials there is not enough evidence to judge a case. */
const ENOUGH = 3;

export function passRate(stats: CaseStats | undefined): number | undefined {
  if (!stats || stats.trials === 0) return undefined;
  return stats.passes / stats.trials;
}

/**
 * How much a case tells you about the difference between two models.
 *
 * Peaks where half of what has been tried passes, which is where a comparison
 * carries the most information, and falls to nothing at either extreme. This
 * is the classic item-analysis shape, scaled so a fresh case with no evidence
 * still counts for something rather than being ignored.
 */
export function discrimination(c: EvalCase): number {
  const p = passRate(c.stats);
  if (p === undefined || (c.stats?.trials ?? 0) < 2) return 0.6;
  return 0.2 + 3.2 * p * (1 - p);
}

export type CaseHealth = "new" | "useful" | "everyone-passes" | "nobody-passes" | "conflicted";

export function health(c: EvalCase): CaseHealth {
  if (c.conflictsWith?.length) return "conflicted";
  const trials = c.stats?.trials ?? 0;
  if (trials < ENOUGH) return "new";
  const p = passRate(c.stats) ?? 0;
  if (p === 1) return "everyone-passes";
  if (p === 0) return "nobody-passes";
  return "useful";
}

/** Plain-language explanation for whatever `health` returned. */
export function explainHealth(c: EvalCase): string {
  switch (health(c)) {
    case "conflicted":
      return "This clashes with something else you taught it — one of them can never pass.";
    case "everyone-passes":
      return "Every brain tried so far gets this right. Kept as a safeguard, but it won't help you choose.";
    case "nobody-passes":
      return "Nothing has ever passed this. That usually means the rule asks for something impossible, not that every model is wrong.";
    case "new":
      return "Not tried enough times yet to know how useful it is.";
    default:
      return "This one actually separates good answers from bad.";
  }
}

/** Record the outcome of one attempt, without letting repeats inflate it. */
export function recordTrial(c: EvalCase, model: string, score: number): EvalCase {
  const stats: CaseStats = c.stats ?? { trials: 0, passes: 0, models: [] };
  const models = stats.models ?? [];

  // The same model re-run is not new evidence about the case.
  if (models.includes(model)) return c;

  return {
    ...c,
    stats: {
      trials: stats.trials + 1,
      passes: stats.passes + (score >= REMEMBERED ? 1 : 0),
      models: [...models, model].slice(-50),
    },
  };
}

/**
 * Two requirements are in conflict when they ask for the same thing with a
 * different value — "within 30 days" against "within 60 days". Blanking the
 * numbers leaves a shape that makes those comparable.
 */
function slot(a: Assertion): string | undefined {
  if (a.kind !== "contains") return undefined;
  if (!/\d/.test(a.value)) return undefined;
  const shape = a.value.toLowerCase().replace(/\d+([.,]\d+)?/g, "#").replace(/\s+/g, " ").trim();
  // A shape of nothing but a number is too generic to reason about.
  return /[a-z]/.test(shape) ? shape : undefined;
}

export interface Conflict {
  caseId: string;
  otherId: string;
  mine: string;
  theirs: string;
}

/** Requirements that ask for the same thing with different numbers. */
export function findConflicts(subject: EvalCase, others: EvalCase[]): Conflict[] {
  const out: Conflict[] = [];

  for (const a of subject.assertions) {
    const shape = slot(a);
    if (!shape) continue;

    for (const other of others) {
      if (other.id === subject.id) continue;
      for (const b of other.assertions) {
        if (slot(b) !== shape) continue;
        if (a.value.toLowerCase() === b.value.toLowerCase()) continue;
        out.push({ caseId: subject.id, otherId: other.id, mine: a.value, theirs: b.value });
      }
    }
  }
  return out;
}

export interface SuiteReport {
  total: number;
  useful: number;
  everyonePasses: number;
  nobodyPasses: number;
  conflicted: number;
  /** Cases worth a person's attention, worst first. */
  needsAttention: { id: string; title: string; why: string }[];
}

export function report(cases: EvalCase[]): SuiteReport {
  const counts = { useful: 0, everyonePasses: 0, nobodyPasses: 0, conflicted: 0 };
  const needsAttention: SuiteReport["needsAttention"] = [];

  for (const c of cases) {
    const h = health(c);
    if (h === "useful") counts.useful++;
    else if (h === "everyone-passes") counts.everyonePasses++;
    else if (h === "nobody-passes") counts.nobodyPasses++;
    else if (h === "conflicted") counts.conflicted++;

    if (h === "conflicted" || h === "nobody-passes") {
      needsAttention.push({ id: c.id, title: c.title, why: explainHealth(c) });
    }
  }

  return { total: cases.length, ...counts, needsAttention };
}
