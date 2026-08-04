# LocalHarness

Build a harness for an open-weight model, and grow a personal eval suite just by using it.

When a new open-weight model ships, the question that matters is not how it scores on MMLU.
It is whether it is better than what you are running now, **for the work you actually do**.
Nobody can answer that from a public leaderboard, because the benchmark you need is made
out of your own tasks, your own context, and your own standards.

So make that benchmark a byproduct of normal use.

```
you do a task  ->  you accept / fix / bin the answer  ->  that verdict becomes a test
                                                                    |
new model ships  ->  replay every test against it  <----------------+
```

This repo is the prototype of the middle of that loop: run a task under a harness, capture
what you thought of the result, and turn it into something replayable. It runs offline
against a mock provider, so the loop can be proven without a GPU.

## Why this half first

Harness builders are a commodity — there are a dozen ways to point a UI at Ollama.
The eval suite is not. It compounds: every week of use makes it a better instrument, and
it is worth exactly nothing to anyone else, which is precisely why it is worth something
to you. The harness builder is how you generate the evals, not the product.

## Quick start

```bash
npm install
npm run build

# Prove the whole loop offline, no model required.
npm run smoke

# Open the load sheet.
npm run ui        # -> http://localhost:4173
```

Then against a real endpoint (Ollama shown; LM Studio, llama.cpp, vLLM, OpenRouter,
Together and Fireworks all speak the same API):

```bash
node dist/cli.js init
node dist/cli.js loadout new work \
  --model qwen2.5-coder:7b \
  --base-url http://localhost:11434/v1 \
  --context 32768
node dist/cli.js loadout equip work read_file search_text
node dist/cli.js loadout pin work NOTES.md

node dist/cli.js run "the task you were about to do anyway" --loadout work
# -> answer prints, then: verdict — [a]ccept [e]dit [r]eject [s]kip

node dist/cli.js replay --model some-new-model
node dist/cli.js report
node dist/cli.js compare <replayA> <replayB>
```

## The load sheet

`npm run ui` serves the real thing on `localhost:4173`, reading and writing the same
`.localharness/` directory the CLI uses. Four screens, in the order the loop runs:
**Loadout** (equip), **Run** (do a task, give a verdict), **Suite** (your cases),
**Trials** (score a new model).

The design is a mass budget, not an RPG inventory — an expedition load sheet, where a
finite allowance is spent by everything you bring. A gauge is pinned to the right of every
screen and never leaves: how many tokens are left for the actual task, which part of the
harness ate the rest, and which model currently leads your standings. Cross 50% and the
figure turns amber; cross 75% and it goes red, because at that point the harness is
crowding out the work.

Opened without a server — from a file, or as a shared page — it falls back to worked demo
data. The fallback is not a mockup: equipping really recomputes the budget and fixing an
answer really mines assertions from the diff, because a faked version of those two moments
would prove nothing. Build a standalone copy with:

```bash
npm run artifact -- demo.html --standalone
```

## The three ideas

### 1. Equipping is a real tradeoff, so show the cost

The game metaphor only works if the slots are genuinely scarce, and here they are.
Every tool schema, every pinned memory file, every line of system prompt is spent from
the same context window the task needs. `lh loadout show` prices the loadout:

```
work  (ld_msels1mj411a07)
  model     qwen2.5-coder:7b  @ http://localhost:11434/v1
  context   [##......................] 9.3% used by harness (382 / 4.1k)
  free      3.7k tokens for the actual task
  tools     373
    - read_file      106
    - search_text    158
    - list_files     109
```

Equip a fourth tool and the meter moves. That is not decoration; it is the actual
constraint, and it is the honest version of an encumbrance stat.

### 2. Your verdict is the label

No hand-authored golden sets. Accept, edit, or reject an answer you were going to
judge anyway, and the system keeps it. An edit is the richest signal of the three,
because the diff says exactly what was wrong.

### 3. An edit becomes assertions

When you fix an output, LocalHarness diffs your correction against the original.
Text you added becomes a `contains` requirement. Text you deleted becomes
`not_contains`. A future model gets graded on the specific thing that was wrong.

From the smoke test — the user changed a refund window from 14 to 30 days:

```
[auto w2] contains:     Refunds are available within 30 days of purchase.
[auto w2] contains:     Original shipping costs are non-refundable.
[auto w1] not_contains: Refunds are available within 14 days of purchase.
[auto w1] not_contains: Shipping costs are refunded in full.
```

A model that learned the correction scores 100%. One that repeats the old mistake
scores 0%. One correction, made during real work, now separates good models from bad
ones forever.

## Grading

Cheapest first, because a grader that costs tokens is a grader you will run less often.

| Grader | Cost | What it is for |
| --- | --- | --- |
| `exact` | free | Structured or templated output |
| `assertions` | free, offline | The mined requirements above. The workhorse. |
| `judge` | tokens | Wording legitimately varies. Opt-in via `LOCALHARNESS_JUDGE_MODEL`. |

Skipped graders do not count toward the score — a missing judge is an absence of
evidence, not evidence of a bad answer.

## Data

Everything is flat JSON under `.localharness/`, one document per record. Open it in an
editor, diff it, back it up, delete a case you disagree with. This is personal data about
how you work, and it should never be somewhere you cannot read it.

```
.localharness/
  loadouts/   the harness: model, prompt, tools, pinned memory
  runs/       every execution, with timings and context accounting
  verdicts/   what you thought
  cases/      runs promoted into replayable tests
  replays/    a model's score against your suite
```

## Environment

| Variable | Purpose |
| --- | --- |
| `LOCALHARNESS_HOME` | Where data lives (default `./.localharness`) |
| `LOCALHARNESS_BASE_URL` | Default endpoint (default `http://localhost:11434/v1`) |
| `LOCALHARNESS_API_KEY` | Bearer token for hosted endpoints |
| `LOCALHARNESS_JUDGE_MODEL` | Enables the judge grader |
| `LOCALHARNESS_JUDGE_BASE_URL` | Endpoint for the judge |
| `LOCALHARNESS_MOCK_SCRIPT` | Scripted replies for `mock://` providers |

## Known limits

These are real and worth fixing before this is a product.

- **Token counts are estimates.** No tokenizer dependency; a heuristic that is
  directionally right within roughly 10-15%. Fine for comparing a tool's cost against a
  prompt's, not fine for a hard "tokens remaining" number a user might trust literally.
  Needs a real per-family tokenizer.
- **Assertions from an *accept* are noisy.** With no diff to mine, it falls back to the
  output's most distinctive lines, which over-specifies wording. Accepts should lean on
  the judge; the anchors are there to catch gross regressions only. Edits are the
  signal worth optimising for.
- **Cases go stale.** Tasks captured in March may not represent your work in September,
  and nothing here ages them out or reweights them yet.
- **One task per case.** No multi-turn conversations captured yet.
- **Tools are read-only and few.** Three of them, deliberately harmless, enough to make
  encumbrance real. A product needs a real registry, and then a real permission model.

## Where this goes next

The loop is the product, and it still needs two things. Capture has to cost nothing —
the UI gets it to one click, but the real answer is an editor or chat plugin so verdicts
come from work already happening rather than work brought here. And the suite needs to
age, so it tracks what you do now instead of what you did in March.
