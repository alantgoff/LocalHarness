# LocalHarness

An assistant that runs on your own computer, learns how you like things, and keeps
everything it learned when you swap its brain for a better one.

A new open-weight model ships every few weeks. The question that matters is never how it
scores on MMLU — it's whether it's better than what you're running now, **for your work**.
No leaderboard can answer that, because the only benchmark that counts is made out of your
own tasks and your own standards.

So build it without anyone noticing they're building it:

```
you ask it to do something  ->  you say "right", "almost", or "no"  ->  it learns a rule
                                                                              |
       a new model ships  ->  check it against everything you taught  <--------+
```

That last step is the whole product. Instead of *"mean score 0.913 across 12 cases"*, you
get:

> **New and fast is better than what you're using.**
> Remembers 3 of the 4 things you taught it. It's about twice as fast.
> It forgot this: *Write a reply to a customer asking about our refund policy.*

## Who this is for

Normal people, first. Someone who doesn't know what a token is should never have to learn,
so nothing on screen says token, context window, endpoint, or eval. It says **room to
think**, **abilities**, and **things it learned**. The engine underneath still counts
tokens and computes mean scores — there's a *Show the numbers* switch that surfaces all of
it, because writing code is the first big use case and developers shouldn't be starved of
detail. But the numbers are opt-in, not the front door.

The reframe that makes this work: **it isn't a benchmark, it's your assistant's education.**
Nobody writes tests for fun. Everybody understands *remember this* and *don't do that
again*.

## Why the learning half is the product

Harness builders are a commodity — there are a dozen ways to point a UI at Ollama. What
your assistant has learned is not. It compounds: every week of use makes it more valuable,
and it's worth nothing to anyone else, which is exactly why it's worth something to you.
It's also the thing that makes switching models safe instead of scary, because your
preferences stop being locked inside whichever model you happened to start with.

## Quick start

```bash
npm install
npm run build

npm run ui        # -> http://localhost:4173

# Or prove the whole loop offline, no model required.
npm run smoke
```

The same thing is available as a CLI, against a real endpoint (Ollama shown; LM Studio,
llama.cpp, vLLM, OpenRouter, Together and Fireworks all speak the same API):

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

## The app

`npm run ui` serves it on `localhost:4173`, reading and writing the same `.localharness/`
directory the CLI uses. Four screens, in the order the loop runs: **Assistant** (set it
up), **Ask it something** (do a task, judge it), **What it's learned** (your rules),
**Try a new brain** (the payoff).

Opened without a server — from a file, or as a shared page — it falls back to worked demo
data. The fallback is not a mockup: giving it an ability really recomputes the budget, and
fixing an answer really mines the rules from the diff, because a faked version of those two
moments would prove nothing. Build a standalone copy with:

```bash
npm run artifact -- demo.html --standalone
```

## What the words mean

Everything on screen is deliberately not the engineering term. The mapping, for anyone
reading the code:

| The code says | The screen says |
| --- | --- |
| Loadout / harness | Your assistant |
| Model, endpoint, base URL | Its brain — plus what your machine needs to run it |
| Context window, tokens, encumbrance | Room to think |
| Tool (`read_file`, `search_text`) | Ability — "Search my files" |
| System prompt | How it should act |
| Pinned memory files | Things it should always know |
| Verdict: accept / edit / reject | "Yes, that's right" / "Almost — let me fix it" / "No" |
| Eval case | Something it learned |
| Assertion `contains` / `not_contains` | "Always say…" / "Never say…" |
| Replay, mean score 0.913 | "Remembers 11 of the 12 things you taught it" |
| Median tokens per second | "It's about twice as fast" |

Costs are shown as a share of the room — *"takes up 1.9% of its room"* — because a
percentage is something anyone can act on and `158 tok` is not. **Show the numbers** puts
every raw figure back, inline.

## The three ideas

### 1. What you give it has a real cost, so show it

Every ability, every pinned note, every line of instruction is spent from the same context
the task itself needs. The app calls that room to think and shows it as a share; the CLI
prices it in tokens:

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

Give it a fourth ability and the meter moves. That isn't decoration — it's the actual
constraint, and it's why the app leads with *"Getting full"* rather than a number.

### 2. Your verdict is the label

No hand-authored golden sets. Say whether an answer was right, wrong, or nearly — a
judgement you were making anyway — and the system keeps it. A fix is the richest of the
three, because the difference says exactly what was wrong.

### 3. A fix becomes rules

When you correct an answer, LocalHarness diffs your version against the original. Text you
added becomes an *always say*. Text you deleted becomes a *never say*. Every future brain
gets checked on the specific thing that was wrong.

From the smoke test — someone changed a refund window from 14 to 30 days:

```
Always say   Refunds are available within 30 days of purchase.
Always say   Original shipping costs are non-refundable.
Never say    Refunds are available within 14 days of purchase.
Never say    Shipping costs are refunded in full.
```

A model that learned the correction scores 100%. One that repeats the old mistake scores
0%. One correction, made during real work, now separates good models from bad ones
forever — and it's written in the user's own words, so they can read it back and delete it
if they disagree.

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

- **Nobody installs the model for you.** The app assumes something is already serving an
  OpenAI-compatible endpoint. For the audience this is aimed at, that assumption is the
  single biggest thing standing between them and using it, and no amount of friendly
  copy on the next screen fixes it. Bundling a runtime, or shipping a hosted
  open-weight endpoint as the default, is the real answer.
- **The brain catalogue is illustrative.** Friendly names, notes and hardware
  requirements in `ui/app.js` are hand-written presentation, not measured. Anything the
  endpoint serves will run; the descriptions need to be checked before they're shown to
  anyone as advice.
- **Token counts are estimates.** No tokenizer dependency; a heuristic that's
  directionally right within roughly 10-15%. Fine for "this ability takes 2% of its
  room", not fine as a hard remaining-capacity figure. Needs a real per-family tokenizer.
- **Rules from a "that's right" are noisy.** With no correction to diff, it falls back to
  the answer's most distinctive lines, which over-specifies wording. Fixes are the signal
  worth optimising for; kept answers lean on the judge.
- **Nothing ages.** What you taught it in March may not describe your work in September,
  and nothing here retires or reweights an old rule yet.
- **Rules can't be edited from the app.** You can read them, which matters, but pruning a
  bad one means opening the JSON. A person who can't delete something the assistant
  "learned" wrongly doesn't really own it.
- **One task at a time.** No multi-turn conversations captured yet.
- **Three abilities, all read-only.** Deliberately harmless, enough to make the cost real.
  A product needs a real catalogue, and then a real permission model.

## Where this goes next

Three things, in order.

**Get the model onto the machine.** Everything else is downstream of this. Right now the
first screen assumes a running endpoint, which quietly excludes exactly the people this is
for.

**Make teaching free.** One click is good; zero is the target. The real answer is an
editor or chat plugin, so a verdict comes from work already happening instead of work
brought here specially.

**Let people curate what it learned.** Editing and retiring rules, from the app, in their
own words. Owning something means being able to change your mind about it.
