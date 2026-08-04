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

## It tunes itself

Once there's a record of what good looks like for one specific person, the setup stops
being a matter of taste and becomes a search problem. So the app searches it — different
brains, different abilities, different settings — scoring each against that person's own
lessons, without asking them anything.

```
$ npm run smoke
7. now let it tune itself, with nobody watching
     [0/8] Checking how your current setup does
     [1/8] Drop "read_file"
     [4/8] Switch to good-model
     [7/8] Let it vary its wording more

   it found:
     +100 pts  Switch to good-model
             why: A different brain, checked against everything you've taught this one.
          result: remembers 1 more of the things you taught it.
     +0 pts  Drop "read_file"
             why: It has never been used on any task you've given it, and it costs
                  2.6% of its room every single time.
          result: remembers the same things, with more room left over to think.
```

Two rules keep it trustworthy, and both are enforced in `src/autotune.ts`:

1. **It never changes anything.** It reports findings; a person applies them. The smoke
   test asserts the stored setup is untouched after a full pass.
2. **It never reports a number without a reason.** "12% better" is a result nobody can
   check. "It never used this on any task you gave it, and it costs 2% of its room" is one
   they can. Findings that don't move the score are still reported when they're free wins —
   dropping an unused ability costs nothing and buys back room.

The search is greedy rather than exhaustive: score the current setup, try one change at a
time, keep what helped, then verify the winners still work *stacked together*, because
changes that each help alone can fight when combined. Exhaustive search costs hundreds of
model calls to beat that by a little, and this has to finish overnight on a laptop.

Every pass has a hard ceiling on model calls, and a pass that runs out says how many
options it never reached. A run that covered half the space and reports nothing reads as
one that covered all of it.

### It also decides *when*

Searching unattended is only half of autonomous; the other half is noticing it's worth
doing. `src/schedule.ts` watches for the two moments that earn the electricity:

- enough new lessons have piled up that the last answer is stale
- a model appeared on this machine that has never been checked

and only ever acts while the app has been sitting untouched, so it never competes for a GPU
someone is in the middle of using. Results are written to disk flagged unread, so overnight
work is waiting when you come back rather than lost to a restart.

Looking for improvements by itself is **off** until switched on. Watching for new models is
on, because noticing is cheap and it's the thing people most want told to them. Both are
toggles on the *Make it better* screen.

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

npm start         # picks a free port, opens your browser

# Or prove the whole loop offline, no model required.
npm run smoke
```

`npm start` is what a downloaded copy runs: no port to remember, no terminal step, and
loopback-only so nothing is reachable from the network. To build a folder you can hand to
someone:

```bash
npm run package   # -> build/LocalHarness/
```

That gives you `LocalHarness.command` (macOS), `LocalHarness.sh` (Linux) and
`LocalHarness.bat` (Windows), with no dependencies to install. It still needs Node.js on
the machine, which means it is not yet a real consumer download — see *Known limits*.

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

Reads and writes the same `.localharness/` directory the CLI uses. Five screens, in the
order the loop runs: **Assistant** (set it up), **Ask it something** (do a task, judge it),
**What it's learned** (your rules), **Make it better** (let it tune itself), **Try a new
brain** (the payoff).

On startup it checks whether anything is actually serving models on the machine. If not, it
says so in plain words with the fix, rather than letting the first real task fail for
reasons a newcomer can't diagnose. When something *is* running, the brain picker lists what
you have installed first and marks the rest *not downloaded*.

Opened without a server — from a file, or as a shared page — it falls back to worked demo
data. The fallback is not a mockup: giving it an ability really recomputes the budget, and
fixing an answer really mines the rules from the diff, because a faked version of those two
moments would prove nothing. Build a standalone copy with:

```bash
npm run artifact -- demo.html --standalone
```

## Before there's a model

The first thing a new install has to survive is having nothing to talk to. The app probes
on startup, and if nothing answers it goes into setup mode: a banner above **every** screen
(not just the one you happened to open), the actions that cannot work disabled with a reason
rather than a raw error, and everything downstream of choosing a brain hidden — because
inviting someone to configure abilities and pinned notes for an assistant that cannot answer
is a promise the app can't keep.

A model that is set but unreachable is badged **set, but not running**, never *using this*.
An app that misreports its own state is worse than one that reports a problem.

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

Some labels cost nothing at all. Copying an answer is real evidence it was usable, given
without being asked and without anyone stopping what they were doing. That's stored too —
but as `source: "implicit"`, shown as *you used it* rather than *you kept it*, and
deliberately **mined for no rules**. Copying tells you an answer was good enough to paste;
it does not tell you every phrase in it was required, and turning it into "always say"
rules would bake in wording nobody chose — including whatever was wrong with it. The
example is kept for the judge to compare against; hard rules come only from a real
correction.

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

- **It is not yet a real download.** `npm run package` produces a folder with a
  double-clickable launcher and zero dependencies, but it still needs Node.js installed.
  For a genuine consumer download the options are Node's single-executable builds (small,
  no window chrome) or Tauri (a real app window, needs Rust in the build). Neither is
  wired up.
- **Nobody installs the model for you.** The app now detects that nothing is running and
  says so in plain words, which is better than failing silently — but detecting a problem
  is not solving it. Someone still has to go install Ollama and pull a model. Bundling a
  runtime, or defaulting to a hosted open-weight endpoint with local as the upgrade, is
  the real answer.
- **Tuning is greedy, and greedy has blind spots.** It tries one change at a time and then
  verifies the winners stacked. A pair of changes that only helps *together* — a bigger
  context window plus an extra note, say — will never be found.
- **The budget is a call count, not a cost.** `maxRunsPerPass` caps model calls, which is
  the right unit on your own GPU and the wrong one on a metered endpoint where a long
  answer costs more than a short one. It should be able to cap actual spend.
- **Rules can be deleted but not rewritten.** You can strike one from the app; changing its
  wording still means editing JSON.
- **Nothing ages.** What you taught it in March may not describe your work in September,
  and nothing retires or reweights an old rule yet. The tuner will happily optimise for a
  lesson that stopped being true.
- **The brain catalogue is illustrative.** Friendly names, notes and hardware
  requirements in `ui/app.js` are hand-written presentation, not measured. Anything the
  endpoint serves will run; the descriptions need to be checked before they're shown to
  anyone as advice.
- **Token counts are estimates.** No tokenizer dependency; a heuristic that's
  directionally right within roughly 10-15%. Fine for "this ability takes 2% of its
  room", not fine as a hard remaining-capacity figure. Needs a real per-family tokenizer.
- **Rules from a stated "that's right" are still noisy.** With no correction to diff, it
  falls back to the answer's most distinctive lines, which over-specifies wording. Fixes
  are the signal worth optimising for. (An *implicit* accept now mines nothing at all.)
- **One task at a time.** No multi-turn conversations captured yet.
- **Contrast is checked, the rest of accessibility is not.** Every colour pair in both
  themes clears WCAG AA (verified by computing the ratios, including composited
  translucent grounds), touch targets clear 24px, inputs have names and focus is visible.
  Nobody has driven it with a screen reader, and the live regions a background job ought
  to announce do not exist.
- **Three abilities, all read-only.** Deliberately harmless, enough to make the cost real.
  A product needs a real catalogue, and then a real permission model.

## Where this goes next

Four things, in order.

**Get the model onto the machine.** Everything else is downstream of this. The app can now
tell you nothing is running; it should be able to fix that itself — download a runtime and
a starter model on first launch, with a progress bar and no terminal.

**Make teaching free.** One click is good; zero is the target. The real answer is an editor
or chat plugin, so a verdict comes from work already happening instead of work brought here
specially. Passive signals — did they copy the answer, did they immediately ask again —
are labels nobody has to stop and give.

**Let the suite age.** Nothing retires an old lesson, so the tuner optimises just as hard
for a rule that stopped being true in March. Confidence should decay, and a lesson that
keeps getting contradicted should ask whether it still holds.

**Tell them without them looking.** It now finds things unprompted and flags them unread,
but someone still has to open the app to discover that. A real notification — "I found
something better while you were asleep" — is what makes this a service rather than a tool
that happens to have a background thread.
