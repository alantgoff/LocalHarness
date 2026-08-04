import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { mineFromAccept, mineFromEdit, mineFromReject, toAssertions } from "./mine.js";
import { findConflicts } from "./suite.js";
import { cases, newId, verdicts } from "./store.js";
import type { EvalCase, Run, Verdict, VerdictKind } from "./types.js";

/**
 * Turning a run into an eval case.
 *
 * The cost of this step is the whole ballgame. If capturing a verdict feels
 * like authoring a test, nobody does it and there is no eval suite. It has to
 * be one keystroke on work the user was doing anyway.
 */

export async function promptVerdict(run: Run): Promise<Verdict> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (
        await rl.question("\nverdict — [a]ccept  [e]dit  [r]eject  [s]kip: ")
      )
        .trim()
        .toLowerCase();

      const kind = { a: "accept", e: "edit", r: "reject", s: "skip" }[answer[0] ?? ""];
      if (!kind) {
        process.stdout.write("  Enter a, e, r or s.\n");
        continue;
      }
      if (kind === "skip") throw new SkipCapture();

      if (kind === "edit") {
        rl.close();
        const corrected = await captureCorrection(run.output);
        if (corrected.trim() === run.output.trim()) {
          // Nothing changed, so it was an accept with extra steps.
          return { kind: "accept", at: new Date().toISOString() };
        }
        return { kind: "edit", correctedOutput: corrected, at: new Date().toISOString() };
      }

      const note = (await rl.question("note (optional): ")).trim();
      return {
        kind: kind as VerdictKind,
        ...(note ? { note } : {}),
        at: new Date().toISOString(),
      };
    }
  } finally {
    rl.close();
  }
}

export class SkipCapture extends Error {
  constructor() {
    super("capture skipped");
    this.name = "SkipCapture";
  }
}

/**
 * Open the output in $EDITOR so correcting it is normal text editing. Falls
 * back to a paste-until-a-lone-dot prompt where no editor is configured.
 */
async function captureCorrection(original: string): Promise<string> {
  const editor = process.env.VISUAL ?? process.env.EDITOR;

  if (editor && process.stdin.isTTY) {
    const dir = mkdtempSync(join(tmpdir(), "localharness-"));
    const file = join(dir, "correction.md");
    writeFileSync(file, original, "utf8");
    const res = spawnSync(editor, [file], { stdio: "inherit", shell: true });
    if (res.status === 0) return readFileSync(file, "utf8");
    process.stdout.write("  Editor exited non-zero; falling back to paste mode.\n");
  }

  process.stdout.write("\nPaste the corrected output. End with a line containing only '.'\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await rl.question("");
      if (line.trim() === ".") break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines.join("\n");
}

function titleFor(input: string): string {
  const firstLine = input.trim().split("\n")[0] ?? input.trim();
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`;
}

/**
 * Promote a run plus verdict into a replayable case.
 *
 * A rejection is worth keeping too: the reference is empty but the rejected
 * text becomes a not_contains set, which is how "stop doing this" gets
 * measured on the next model.
 */
export function promoteToCase(run: Run, verdict: Verdict, tags: string[] = []): EvalCase {
  verdicts.save(run.id, verdict);

  let reference: string;
  let assertions;
  let antiReference: string | undefined;

  switch (verdict.kind) {
    case "edit":
      reference = verdict.correctedOutput ?? "";
      assertions = toAssertions(mineFromEdit(run.output, reference));
      antiReference = run.output;
      break;
    case "accept":
      reference = run.output;
      // An inferred accept is weaker evidence than a stated one. Copying an
      // answer says it was usable; it does not say every phrase in it is
      // required, and mining hard "always say" rules out of it would bake in
      // wording nobody chose — including whatever was wrong with it. The
      // example is still kept, so the judge can compare against it.
      assertions = verdict.source === "implicit" ? [] : toAssertions(mineFromAccept(run.output));
      break;
    case "reject":
      reference = "";
      assertions = toAssertions(mineFromReject(run.output));
      antiReference = run.output;
      break;
  }

  // With no reference text there is nothing for a judge to compare against.
  const graders = reference.trim() ? (["assertions", "judge"] as const) : (["assertions"] as const);

  const evalCase: EvalCase = {
    id: newId("case"),
    createdAt: new Date().toISOString(),
    title: titleFor(run.input),
    input: run.input,
    loadoutId: run.loadoutId,
    reference,
    origin: {
      runId: run.id,
      verdict: verdict.kind,
      model: run.model,
      ...(verdict.source ? { source: verdict.source } : {}),
    },
    assertions,
    graders: [...graders],
    ...(antiReference ? { antiReference } : {}),
    tags,
  };

  // A lesson that contradicts an earlier one guarantees that one of them fails
  // forever, dragging every score down for a reason no number explains. Say so
  // at the moment it happens, while the user still remembers both.
  const conflicts = findConflicts(evalCase, cases.list());
  if (conflicts.length) {
    evalCase.conflictsWith = [...new Set(conflicts.map((c) => c.otherId))];
    for (const id of evalCase.conflictsWith) {
      const other = cases.get(id);
      if (!other) continue;
      other.conflictsWith = [...new Set([...(other.conflictsWith ?? []), evalCase.id])];
      cases.save(other);
    }
  }

  cases.save(evalCase);
  return evalCase;
}
