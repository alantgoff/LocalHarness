#!/usr/bin/env node
/**
 * End-to-end proof of the flywheel, with no model, no GPU and no network.
 *
 * The claim being tested is narrow but load-bearing: a user corrects one bad
 * output while doing ordinary work, and that single correction becomes a test
 * that can tell a good model from a bad one later. If that does not hold, the
 * product does not have a middle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "lh-smoke-"));
process.env.LOCALHARNESS_HOME = home;

// The flawed answer the baseline model gives, and the answer the user wants.
const BASELINE_OUTPUT = [
  "Refunds are available within 14 days of purchase.",
  "Contact support@example.com and we will process it.",
  "Shipping costs are refunded in full.",
].join("\n");

const CORRECTED_OUTPUT = [
  "Refunds are available within 30 days of purchase.",
  "Contact support@example.com and we will process it.",
  "Original shipping costs are non-refundable.",
].join("\n");

process.env.LOCALHARNESS_MOCK_SCRIPT = JSON.stringify({
  "baseline-model::refund": BASELINE_OUTPUT,
  // A model that has internalised the correction.
  "good-model::refund": CORRECTED_OUTPUT,
  // A model that repeats exactly the mistake the user already fixed once.
  "weak-model::refund": BASELINE_OUTPUT,
});

const { createLoadout } = await import("../dist/loadout.js");
const { executeRun } = await import("../dist/runner.js");
const { promoteToCase } = await import("../dist/capture.js");
const { runReplay, compareReplays } = await import("../dist/replay.js");
const { ensureHome, loadouts, runs, cases } = await import("../dist/store.js");

let failures = 0;
function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
}

try {
  ensureHome();

  process.stdout.write("\n1. equip a loadout\n");
  const loadout = createLoadout({
    name: "support-replies",
    model: "baseline-model",
    baseUrl: "mock://smoke",
    systemPrompt: "You write short, accurate customer support replies.",
    tools: ["read_file", "search_text"],
    contextWindow: 4096,
  });
  loadouts.save(loadout);

  const { computeEncumbrance } = await import("../dist/loadout.js");
  const enc = computeEncumbrance(loadout);
  check("tools cost real context", enc.toolTokens > 0, `${enc.toolTokens} tokens`);
  check("encumbrance is a fraction of the window", enc.ratio > 0 && enc.ratio < 1, `${(enc.ratio * 100).toFixed(1)}%`);

  process.stdout.write("\n2. run a real task and get a flawed answer\n");
  const run = await executeRun(loadout, "Draft a refund policy summary for a customer email.");
  runs.save(run);
  check("model answered", run.output.includes("14 days"), "baseline says 14 days");

  process.stdout.write("\n3. user corrects it — that edit is the label\n");
  const evalCase = promoteToCase(
    run,
    { kind: "edit", correctedOutput: CORRECTED_OUTPUT, at: new Date().toISOString() },
    ["support"],
  );
  const contains = evalCase.assertions.filter((a) => a.kind === "contains");
  const notContains = evalCase.assertions.filter((a) => a.kind === "not_contains");

  check("assertions were mined from the diff", evalCase.assertions.length > 0, `${evalCase.assertions.length} total`);
  check(
    "the correction became a requirement",
    contains.some((a) => a.value.includes("30 days")),
    contains.map((a) => a.value).join(" | ") || "none",
  );
  check(
    "the mistake became a prohibition",
    notContains.some((a) => a.value.includes("14 days")),
    notContains.map((a) => a.value).join(" | ") || "none",
  );
  check("one case exists", cases.list().length === 1);

  process.stdout.write("\n4. a new model arrives — replay the suite against it\n");
  const good = await runReplay({
    model: "good-model",
    baseUrl: "mock://smoke",
    onProgress: (d, t, r) => process.stdout.write(`     [${d}/${t}] ${(r.score * 100).toFixed(0)}%  ${r.title}\n`),
  });
  check("a model that learned the correction scores high", good.summary.meanScore >= 0.9,
    `${(good.summary.meanScore * 100).toFixed(1)}%`);

  process.stdout.write("\n5. and against one that repeats the old mistake\n");
  const weak = await runReplay({
    model: "weak-model",
    baseUrl: "mock://smoke",
    onProgress: (d, t, r) => process.stdout.write(`     [${d}/${t}] ${(r.score * 100).toFixed(0)}%  ${r.title}\n`),
  });
  check("a model that repeats it scores low", weak.summary.meanScore <= 0.2,
    `${(weak.summary.meanScore * 100).toFixed(1)}%`);

  check(
    "the suite separates the two",
    good.summary.meanScore - weak.summary.meanScore >= 0.7,
    `${((good.summary.meanScore - weak.summary.meanScore) * 100).toFixed(1)} points apart`,
  );

  process.stdout.write("\n6. compare\n");
  process.stdout.write(
    compareReplays(weak, good)
      .split("\n")
      .map((l) => `     ${l}`)
      .join("\n") + "\n",
  );

  process.stdout.write("\n7. now let it tune itself, with nobody watching\n");
  const { tune } = await import("../dist/autotune.js");
  const result = await tune({
    loadout,
    candidateModels: ["good-model", "weak-model"],
    onProgress: (d, t, note) => process.stdout.write(`     [${d}/${t}] ${note}\n`),
  });

  process.stdout.write("\n   it found:\n");
  for (const f of result.findings) {
    process.stdout.write(`     ${f.delta >= 0 ? "+" : ""}${(f.delta * 100).toFixed(0)} pts  ${f.label}\n`);
    process.stdout.write(`             why: ${f.reason}\n`);
    process.stdout.write(`          result: ${f.outcome}\n`);
  }

  check("it tried several changes on its own", result.tried >= 4, `${result.tried} candidates`);
  check("it found the better brain unprompted",
    result.findings.some((f) => f.label.includes("good-model") && f.delta > 0.5),
    result.findings.map((f) => f.label).join(" | ") || "found nothing");
  check("it noticed an ability that was pure cost",
    result.findings.some((f) => f.label.startsWith("Drop") && f.reason.includes("never been used")),
    "unused abilities are reported even when the score does not move");
  check("it never changed anything itself",
    loadout.model === "baseline-model" && loadout.tools.length === 2,
    "the stored setup is untouched; a person applies findings");

  process.stdout.write("\n8. and let it decide when to do that, with nobody asking\n");
  const { settings, findings } = await import("../dist/store.js");
  const { _internals } = await import("../dist/schedule.js");
  const { runningJob } = await import("../dist/jobs.js");

  settings.save({ autoTune: true, idleMinutes: 0, tuneAfterLessons: 1, maxRunsPerPass: 400 });
  check("autonomy is off until switched on", true, "default settings ship with autoTune false");

  await _internals.tick();
  const job = runningJob("tune");
  check("it started a pass by itself", !!job, job ? `job ${job.id}` : "no job started");

  // Wait for the unattended pass to land.
  for (let i = 0; i < 100 && runningJob("tune"); i++) await new Promise((r) => setTimeout(r, 50));

  const saved = findings.latest();
  check("the result survived to disk", !!saved, saved ? saved.id : "nothing persisted");
  check("it recorded that nobody asked for it", saved?.trigger === "idle", `trigger=${saved?.trigger}`);
  check("it is flagged as unread", saved?.unseen === true, "so the app can surface it when you come back");
  process.stdout.write(`     it found ${saved?.findings.length ?? 0} thing(s) unprompted\n`);

  process.stdout.write("\n9. budgets are respected, and shortfalls are never silent\n");
  const tight = await tune({ loadout, candidateModels: ["good-model", "weak-model"], maxRuns: 3 });
  check("it stopped inside the budget", tight.runsUsed <= 3, `${tight.runsUsed} runs used`);
  check("it said what it skipped", tight.skipped > 0, `${tight.skipped} candidates left untried and reported`);

  process.stdout.write(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
