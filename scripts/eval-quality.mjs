#!/usr/bin/env node
/**
 * Does the suite measure meaning, or does it measure vocabulary?
 *
 * The first mining engine scored an answer with identical facts and different
 * wording at 33%, and an answer with a *wrong fact* at 67%. It was grading
 * phrasing, and grading it backwards — and a tuner fed those numbers rejects
 * better models for choosing different words. These tests exist so that never
 * silently comes back.
 *
 *   node scripts/eval-quality.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "lh-eval-"));
process.env.LOCALHARNESS_HOME = home;

let failures = 0;
function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
}

const { mineFromEdit, mineFromAccept, mineFromReject, toAssertions } = await import("../dist/mine.js");
const { gradeAssertions } = await import("../dist/grade.js");
const { discrimination, findConflicts, health, recordTrial, report } = await import("../dist/suite.js");

try {
  // ── 1. rules are the smallest thing that changed ───────────────────────────
  process.stdout.write("\n1. a correction yields the span that changed, not the sentence\n");
  const before = "Refunds are available within 14 days of purchase.\nShipping costs are refunded in full.";
  const after = "Refunds are available within 30 days of purchase.\nOriginal shipping costs are non-refundable.";
  const rules = mineFromEdit(before, after);
  const values = rules.map((r) => r.value);

  check("it isolates the corrected fact", values.includes("30 days"), values.join(" | "));
  check("it isolates the mistake", values.includes("14 days"));
  check("it does not demand whole sentences",
    !values.some((v) => v.includes("Refunds are available within")),
    "whole-sentence rules are what broke paraphrase");
  check("facts are treated as facts",
    rules.find((r) => r.value === "30 days")?.class === "fact");

  // ── 2. facts gate, phrasing does not ───────────────────────────────────────
  process.stdout.write("\n2. facts must hold; wording is free\n");
  check("a required fact gates", rules.find((r) => r.value === "30 days")?.soft === false);
  check("a prohibition gates", rules.find((r) => r.value === "refunded in full")?.soft === false);
  const phrasing = rules.find((r) => r.kind === "contains" && r.class === "wording");
  check("a preferred phrasing does not gate", phrasing?.soft === true, phrasing ? `"${phrasing.value}"` : "none mined");

  // ── 3. the measurement this was all for ────────────────────────────────────
  process.stdout.write("\n3. it grades meaning, not vocabulary\n");
  const c = { assertions: toAssertions(rules) };
  const score = (out) => gradeAssertions(c, out).score;

  const sameFacts = score("You can request a refund up to 30 days after buying. We do not refund the original shipping.");
  const wrongFact = score("Refunds are available within 30 days of purchase. Shipping costs are refunded in full.");
  const allWrong = score("Refunds are available within 14 days of purchase.");

  check("identical facts, different words, full marks", sameFacts >= 0.99, `${Math.round(sameFacts * 100)}%`);
  check("a wrong fact is penalised", wrongFact < sameFacts, `${Math.round(wrongFact * 100)}% vs ${Math.round(sameFacts * 100)}%`);
  check("the old inversion is gone", sameFacts > wrongFact,
    "a paraphrase used to score below an answer with a wrong fact");
  check("a wholly wrong answer scores low", allWrong <= 0.3, `${Math.round(allWrong * 100)}%`);

  // ── 4. rules must earn their place ─────────────────────────────────────────
  process.stdout.write("\n4. a rule that proves nothing is not kept\n");
  const noop = mineFromEdit("The answer is 42.", "The answer is 42.");
  check("an edit that changed nothing yields nothing", noop.length === 0, `${noop.length} rules`);

  const trailing = mineFromEdit("Ready to go", "Ready to go now");
  check("every kept rule tells the two answers apart",
    trailing.every((r) =>
      r.kind === "contains"
        ? "ready to go now".includes(r.value.toLowerCase()) && !"ready to go".includes(r.value.toLowerCase())
        : !"ready to go now".includes(r.value.toLowerCase())),
    trailing.map((r) => `${r.kind} "${r.value}"`).join(", ") || "none");

  check("an accepted answer anchors its facts only",
    mineFromAccept("Delivery takes 5-8 working days and we are open Mondays.").every((r) => /\d/.test(r.value)));
  check("a rejection yields only prohibitions",
    mineFromReject("I do not have access to your bug tracker.").every((r) => r.kind === "not_contains"));

  // ── 5. the suite knows which of its own cases are worth anything ───────────
  process.stdout.write("\n5. the suite grades itself\n");
  const base = {
    id: "c1", createdAt: "", title: "Refund window", input: "i", loadoutId: "l",
    reference: "r", origin: { runId: "r", verdict: "edit", model: "m" },
    assertions: toAssertions(rules), graders: ["assertions"], tags: [],
  };

  let everyone = base;
  let nobody = { ...base, id: "c2" };
  let splits = { ...base, id: "c3" };
  for (const m of ["a", "b", "c", "d"]) {
    everyone = recordTrial(everyone, m, 1);
    nobody = recordTrial(nobody, m, 0);
    splits = recordTrial(splits, m, m < "c" ? 1 : 0);
  }

  check("a case everything passes is spotted", health(everyone) === "everyone-passes");
  check("a case nothing passes is spotted", health(nobody) === "nobody-passes",
    "more likely an impossible rule than a universal failing");
  check("a case that splits models is the useful one", health(splits) === "useful");
  check("the one that decides carries the most weight",
    discrimination(splits) > discrimination(everyone) && discrimination(splits) > discrimination(nobody),
    `${discrimination(splits).toFixed(2)} vs ${discrimination(everyone).toFixed(2)}`);

  check("the same model re-run is not counted twice",
    recordTrial(everyone, "a", 0).stats.trials === everyone.stats.trials);

  const health_report = report([everyone, nobody, splits]);
  check("problems are surfaced for review", health_report.needsAttention.length === 1,
    health_report.needsAttention.map((n) => n.title).join(", "));

  // ── 6. lessons that cannot both be true ────────────────────────────────────
  process.stdout.write("\n6. contradictory lessons are caught\n");
  const older = { ...base, id: "old", assertions: [{ kind: "contains", value: "within 30 days", source: "auto", weight: 3 }] };
  const newer = { ...base, id: "new", assertions: [{ kind: "contains", value: "within 60 days", source: "auto", weight: 3 }] };
  const clash = findConflicts(newer, [older]);
  check("two answers to the same question clash", clash.length === 1,
    clash.length ? `"${clash[0].mine}" vs "${clash[0].theirs}"` : "not detected");

  const unrelated = { ...base, id: "u", assertions: [{ kind: "contains", value: "5-8 working days", source: "auto", weight: 3 }] };
  check("unrelated facts do not", findConflicts(unrelated, [older]).length === 0);

  process.stdout.write(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
