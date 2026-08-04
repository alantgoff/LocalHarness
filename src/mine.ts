import type { Assertion, MinedRule, RuleClass } from "./types.js";

/**
 * Turning one correction into rules worth keeping.
 *
 * The first version of this took whole changed sentences and required them
 * verbatim. Measured, it graded an answer with identical facts and different
 * wording at 33%, and an answer with a *wrong fact* at 67% — it was scoring
 * phrasing, and scoring it backwards. A tuner fed those numbers rejects better
 * models for choosing different words.
 *
 * Three ideas fix it.
 *
 * MINIMAL SPANS. When someone changes "14 days" to "30 days", the thing they
 * corrected is the number, not the sentence around it. Diffing at word level
 * and keeping the smallest span that actually differs turns a brittle
 * sentence match into a durable one.
 *
 * NEGATIVE RULES ARE STRONGER THAN POSITIVE ONES. "Never say X" is reliably
 * checkable: a model that regresses says the wrong thing, and there it is.
 * "Always say Y" over-constrains, because a hundred phrasings are equally
 * correct. So prohibitions gate; requirements gate only when they name a fact
 * that cannot be paraphrased away — a number, a date, an address, a code.
 * Everything else is recorded as soft: real signal, but it does not fail
 * anyone on wording.
 *
 * RULES MUST DISCRIMINATE. Every candidate is checked against both texts it
 * came from. A rule the original answer already satisfied proves nothing; a
 * rule the corrected answer fails is broken. Both are dropped at mining time
 * rather than left to pollute the suite.
 */

const WORD = /[A-Za-z0-9][A-Za-z0-9'’]*(?:[-–][A-Za-z0-9'’]+)*|[^\s]/gu;

/** A token that carries meaning, as opposed to punctuation. */
function isWord(t: string): boolean {
  return /[A-Za-z0-9]/.test(t);
}

/** Facts survive paraphrase; prose does not. */
function isFactual(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      /\d/.test(t) || // numbers, dates, versions, money
      /@|https?:|\.\w{2,}$/.test(t) || // addresses and links
      /^[A-Z][a-z]+$/.test(t) === false && /^[A-Z]{2,}$/.test(t), // acronyms
  );
}

function tokenize(text: string): string[] {
  return text.match(WORD) ?? [];
}

interface Op {
  type: "same" | "del" | "ins";
  tokens: string[];
}

/** Word-level diff, grouped into runs. */
export function diffTokens(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i]!;
      const next = table[i + 1]!;
      row[j] =
        a[i]!.toLowerCase() === b[j]!.toLowerCase() ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const ops: Op[] = [];
  const push = (type: Op["type"], token: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.tokens.push(token);
    else ops.push({ type, tokens: [token] });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]!.toLowerCase() === b[j]!.toLowerCase()) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push("del", a[i]!);
      i++;
    } else {
      push("ins", b[j]!);
      j++;
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("ins", b[j++]!);
  return ops;
}

/** Trim punctuation off the ends and rejoin as a matchable phrase. */
function phrase(tokens: string[]): string {
  const words = [...tokens];
  while (words.length && !isWord(words[0]!)) words.shift();
  while (words.length && !isWord(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

const MIN_CHARS = 4;

/**
 * Grow a changed span with neighbouring context until it is specific enough to
 * be worth asserting. A bare "30" matches far too much; "30 days" does not.
 */
function withContext(changed: string[], before: string[], after: string[]): string {
  let span = phrase(changed);
  let left = 0;
  let right = 0;

  const specific = () => {
    const words = span.split(" ").filter(isWord);
    if (!words.length) return false;
    if (span.length < MIN_CHARS) return false;
    // A lone number needs a unit; two content words stand on their own.
    if (words.length === 1 && /^\d+$/.test(words[0]!)) return false;
    return words.length >= 2 || span.length >= 8;
  };

  while (!specific() && (right < after.length || left < before.length) && left + right < 6) {
    if (right < after.length) {
      right++;
      span = phrase([...changed, ...after.slice(0, right)]);
      if (specific()) break;
    }
    if (left < before.length) {
      left++;
      span = phrase([...before.slice(before.length - left), ...changed, ...after.slice(0, right)]);
    }
  }
  return span;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A rule only survives if it tells the two answers apart. Anything the
 * original already satisfied is noise; anything the correction fails is broken.
 */
function discriminates(rule: MinedRule, original: string, corrected: string): boolean {
  const o = normalize(original);
  const c = normalize(corrected);
  const v = normalize(rule.value);
  if (!v) return false;
  return rule.kind === "contains" ? c.includes(v) && !o.includes(v) : !c.includes(v) && o.includes(v);
}

function classify(tokens: string[]): RuleClass {
  return isFactual(tokens) ? "fact" : "wording";
}

/**
 * Facts gate. Prohibitions gate. Requirements about prose do not, because a
 * hundred phrasings are equally right and failing all but one is how you end
 * up rejecting a better model for using different words.
 */
function strengthOf(kind: MinedRule["kind"], cls: RuleClass): { soft: boolean; weight: number } {
  if (kind === "not_contains") return { soft: false, weight: cls === "fact" ? 3 : 2 };
  if (cls === "fact") return { soft: false, weight: 3 };
  return { soft: true, weight: 1 };
}

function rule(
  kind: MinedRule["kind"],
  value: string,
  tokens: string[],
  why: string,
): MinedRule | undefined {
  if (!value) return undefined;
  const cls = classify(tokens);
  const { soft, weight } = strengthOf(kind, cls);
  return { kind, value, class: cls, soft, weight, why, source: "auto" };
}

/** Split a correction into the runs that changed, ignoring what stayed. */
export function mineFromEdit(original: string, corrected: string): MinedRule[] {
  const ops = diffTokens(tokenize(original), tokenize(corrected));
  const out: MinedRule[] = [];

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.type === "same") continue;

    const prev = ops[k - 1]?.type === "same" ? ops[k - 1]!.tokens : [];
    const nextOp = ops[k + 1];
    const paired = op.type === "del" && nextOp?.type === "ins" ? nextOp : undefined;
    const following = (paired ? ops[k + 2] : nextOp)?.type === "same"
      ? (paired ? ops[k + 2]! : nextOp!).tokens
      : [];

    if (op.type === "del") {
      const gone = withContext(op.tokens, prev, following);
      const r = rule("not_contains", gone, op.tokens, paired ? "you replaced this" : "you removed this");
      if (r) out.push(r);
    }
    if (paired || op.type === "ins") {
      const added = paired ? paired.tokens : op.tokens;
      const span = withContext(added, prev, following);
      const r = rule("contains", span, added, paired ? "you put this in its place" : "you added this");
      if (r) out.push(r);
    }
    if (paired) k++; // the insertion was consumed with its deletion
  }

  return finalize(out, original, corrected);
}

const MAX_RULES = 10;

function finalize(candidates: MinedRule[], original: string, corrected: string): MinedRule[] {
  const seen = new Set<string>();
  const kept: MinedRule[] = [];

  for (const r of candidates) {
    const key = `${r.kind}:${normalize(r.value)}`;
    if (seen.has(key)) continue;
    if (!discriminates(r, original, corrected)) continue;
    seen.add(key);
    kept.push(r);
  }

  // Facts first, then prohibitions, then the soft wording notes.
  kept.sort((a, b) => Number(b.weight) - Number(a.weight) || Number(a.soft) - Number(b.soft));
  return kept.slice(0, MAX_RULES);
}

/**
 * A rejection says only what must never happen again, so every rule from one
 * is a prohibition — and prohibitions are the reliable kind.
 */
export function mineFromReject(output: string): MinedRule[] {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);

  const out: MinedRule[] = [];
  for (const line of lines.slice(0, 3)) {
    const tokens = tokenize(line);
    const r = rule("not_contains", phrase(tokens), tokens, "you said this was wrong");
    if (r) out.push(r);
  }
  return out.slice(0, 3);
}

/**
 * An accepted answer has nothing to diff against, so there is no evidence
 * about which parts mattered. Facts in it are worth anchoring; the prose is
 * not, and asserting it would freeze one phrasing as the only correct one.
 */
export function mineFromAccept(output: string): MinedRule[] {
  const out: MinedRule[] = [];
  for (const line of output.split("\n")) {
    const tokens = tokenize(line);
    for (let i = 0; i < tokens.length; i++) {
      if (!/\d/.test(tokens[i]!)) continue;
      const span = withContext([tokens[i]!], tokens.slice(Math.max(0, i - 3), i), tokens.slice(i + 1));
      const r = rule("contains", span, [tokens[i]!], "a fact in an answer you kept");
      if (r && !out.some((x) => normalize(x.value) === normalize(r.value))) out.push(r);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

/** Mined rules are stored as ordinary assertions; the extra fields ride along. */
export function toAssertions(rules: MinedRule[]): Assertion[] {
  return rules.map((r) => ({
    kind: r.kind,
    value: r.value,
    source: r.source,
    weight: r.weight,
    class: r.class,
    soft: r.soft,
    why: r.why,
  }));
}
