import { gradeCase, judgeFromEnv } from "./grade.js";
import { executeRun } from "./runner.js";
import { cases as caseStore, loadouts, newId, replays } from "./store.js";
import type { CaseResult, EvalCase, Loadout, Replay } from "./types.js";

/**
 * The payoff.
 *
 * A new open-weight model ships. Point this at it and get back an answer about
 * your work, not about MMLU: which of your captured tasks it still gets right,
 * which it regresses on, and how fast. That number is not portable or
 * comparable to anyone else's, and that is the feature.
 */

export interface ReplayOptions {
  model: string;
  baseUrl?: string;
  /** Restrict to cases captured under one loadout. */
  loadoutRef?: string;
  tags?: string[];
  cwd?: string;
  onProgress?: (done: number, total: number, result: CaseResult) => void;
}

function selectCases(opts: ReplayOptions): EvalCase[] {
  let selected = caseStore.list();
  if (opts.loadoutRef) {
    const l = loadouts.find(opts.loadoutRef);
    if (!l) throw new Error(`no such loadout: ${opts.loadoutRef}`);
    selected = selected.filter((c) => c.loadoutId === l.id);
  }
  if (opts.tags?.length) {
    selected = selected.filter((c) => opts.tags!.some((t) => c.tags.includes(t)));
  }
  return selected;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function runReplay(opts: ReplayOptions): Promise<Replay> {
  const selected = selectCases(opts);
  if (!selected.length) {
    throw new Error("no cases to replay — capture some runs first with `lh run`");
  }

  const judge = judgeFromEnv();
  const results: CaseResult[] = [];
  const loadoutCache = new Map<string, Loadout>();

  for (const evalCase of selected) {
    let loadout = loadoutCache.get(evalCase.loadoutId);
    if (!loadout) {
      const found = loadouts.get(evalCase.loadoutId);
      if (!found) {
        results.push({
          caseId: evalCase.id,
          title: evalCase.title,
          output: "",
          score: 0,
          graders: [],
          ms: 0,
          tokensPerSec: 0,
          error: `loadout ${evalCase.loadoutId} no longer exists`,
        });
        continue;
      }
      loadout = found;
      loadoutCache.set(evalCase.loadoutId, loadout);
    }

    // Same harness, same task, different model. That is the only variable
    // allowed to change, or the comparison means nothing.
    const run = await executeRun(loadout, evalCase.input, {
      model: opts.model,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    const graded = run.error && !run.output
      ? { score: 0, graders: [] }
      : await gradeCase(evalCase, run.output, judge);

    const result: CaseResult = {
      caseId: evalCase.id,
      title: evalCase.title,
      output: run.output,
      score: graded.score,
      graders: graded.graders,
      ms: run.stats.ms,
      tokensPerSec: run.stats.tokensPerSec,
      ...(run.error ? { error: run.error } : {}),
    };
    results.push(result);
    opts.onProgress?.(results.length, selected.length, result);
  }

  const scored = results.filter((r) => !r.error);
  const replay: Replay = {
    id: newId("rep"),
    createdAt: new Date().toISOString(),
    model: opts.model,
    baseUrl: opts.baseUrl ?? loadoutCache.values().next().value?.baseUrl ?? "",
    loadoutId: opts.loadoutRef ? (loadouts.find(opts.loadoutRef)?.id ?? "") : "",
    results,
    summary: {
      cases: results.length,
      scored: scored.length,
      meanScore: scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0,
      medianTokensPerSec: median(scored.map((r) => r.tokensPerSec)),
      failures: results.length - scored.length,
    },
  };

  replays.save(replay);
  return replay;
}

/** Side-by-side of two replays, which is how a model swap gets decided. */
export function compareReplays(a: Replay, b: Replay): string {
  const lines: string[] = [];
  const byCase = new Map(a.results.map((r) => [r.caseId, r]));

  lines.push(`${a.model}  ->  ${b.model}`);
  lines.push(
    `mean ${(a.summary.meanScore * 100).toFixed(1)}%  ->  ${(b.summary.meanScore * 100).toFixed(1)}%` +
      `   (${b.summary.meanScore >= a.summary.meanScore ? "+" : ""}` +
      `${((b.summary.meanScore - a.summary.meanScore) * 100).toFixed(1)} pts)`,
  );
  lines.push(
    `speed ${a.summary.medianTokensPerSec.toFixed(1)} tok/s  ->  ${b.summary.medianTokensPerSec.toFixed(1)} tok/s`,
  );
  lines.push("");

  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const rb of b.results) {
    const ra = byCase.get(rb.caseId);
    if (!ra) continue;
    const delta = rb.score - ra.score;
    if (delta <= -0.15) {
      regressions.push(`  - ${rb.title}  ${(ra.score * 100).toFixed(0)}% -> ${(rb.score * 100).toFixed(0)}%`);
    } else if (delta >= 0.15) {
      improvements.push(`  + ${rb.title}  ${(ra.score * 100).toFixed(0)}% -> ${(rb.score * 100).toFixed(0)}%`);
    }
  }

  if (regressions.length) {
    lines.push(`regressions (${regressions.length}):`);
    lines.push(...regressions);
  }
  if (improvements.length) {
    lines.push(`improvements (${improvements.length}):`);
    lines.push(...improvements);
  }
  if (!regressions.length && !improvements.length) {
    lines.push("no case moved by more than 15 points.");
  }
  return lines.join("\n");
}
