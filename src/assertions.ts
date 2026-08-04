import type { Assertion } from "./types.js";

/**
 * Mine assertions out of the user's edit.
 *
 * When someone fixes a model's output, the fix itself is labelled data. Text
 * they added is text that needed to be there; text they deleted is text that
 * should not have been. Turning that into contains / not_contains checks means
 * a future model gets graded on the specific thing that was wrong, not on a
 * vague similarity score.
 *
 * These are proposals, not judgements. They are written to the case file as
 * source: "auto" precisely so a user can open it and delete the silly ones.
 */

const MAX_AUTO_ASSERTIONS = 8;
const MIN_SEGMENT_CHARS = 12;

/** Split into comparable segments: lines, then sentences within long lines. */
function segment(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 160) {
      out.push(trimmed);
      continue;
    }
    for (const s of trimmed.split(/(?<=[.!?])\s+/)) {
      const st = s.trim();
      if (st) out.push(st);
    }
  }
  return out;
}

interface DiffResult {
  added: string[];
  removed: string[];
}

/** Longest common subsequence over segments, so moves aren't read as edits. */
export function diffSegments(before: string[], after: string[]): DiffResult {
  const n = before.length;
  const m = after.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i]!;
      const next = table[i + 1]!;
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed.push(before[i]!);
      i++;
    } else {
      added.push(after[j]!);
      j++;
    }
  }
  while (i < n) removed.push(before[i++]!);
  while (j < m) added.push(after[j++]!);

  return { added, removed };
}

/** Regex metacharacters and stray quoting make brittle substring checks. */
function isUsableSegment(s: string): boolean {
  if (s.length < MIN_SEGMENT_CHARS) return false;
  // Needs some actual words, not just punctuation or a bare delimiter.
  const words = s.match(/[A-Za-z0-9]{2,}/g);
  return !!words && words.length >= 2;
}

/** Prefer the most distinctive segments; long and word-dense wins. */
function rank(segments: string[]): string[] {
  return [...new Set(segments)]
    .filter(isUsableSegment)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_AUTO_ASSERTIONS);
}

export function assertionsFromEdit(rawOutput: string, corrected: string): Assertion[] {
  const { added, removed } = diffSegments(segment(rawOutput), segment(corrected));
  const assertions: Assertion[] = [];

  for (const s of rank(added)) {
    // Text the user wrote in is the strongest signal available.
    assertions.push({ kind: "contains", value: s, source: "auto", weight: 2 });
  }
  for (const s of rank(removed)) {
    assertions.push({ kind: "not_contains", value: s, source: "auto", weight: 1 });
  }
  return assertions.slice(0, MAX_AUTO_ASSERTIONS);
}

/**
 * An accepted output has no diff to mine, so fall back to its most distinctive
 * lines. These are weaker and weighted accordingly: an accept mostly leans on
 * the judge grader, with a few cheap anchors to catch gross regressions.
 */
export function assertionsFromAccept(output: string): Assertion[] {
  return rank(segment(output))
    .slice(0, 3)
    .map((value) => ({ kind: "contains" as const, value, source: "auto" as const, weight: 1 }));
}

/** A rejection says what must not happen again. */
export function assertionsFromReject(output: string): Assertion[] {
  return rank(segment(output))
    .slice(0, 3)
    .map((value) => ({ kind: "not_contains" as const, value, source: "auto" as const, weight: 2 }));
}
