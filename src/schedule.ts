import { tune } from "./autotune.js";
import { runningJob, startJob } from "./jobs.js";
import { runReplay } from "./replay.js";
import { cases, findings, loadouts, newId, settings } from "./store.js";
import type { FindingsRecord } from "./types.js";

/**
 * Deciding *when*, which is the difference between a tool and a service.
 *
 * The engine could already search the configuration space unattended. What it
 * could not do was notice that it was worth doing. This watches for the two
 * moments where an unprompted pass earns its electricity:
 *
 *   - enough new lessons have accumulated that the old answer is stale
 *   - a model appeared on this machine that has never been checked
 *
 * and only ever acts while the app is sitting untouched, so it never competes
 * with the person for the GPU they are in the middle of using.
 */

const TICK_MS = 60_000;
const MODEL_CHECK_MS = 15 * 60_000;

let lastActivity = Date.now();
let lastModelCheck = 0;
let timer: NodeJS.Timeout | undefined;

/** Called on real user requests. Polling and health checks do not count. */
export function noteActivity(): void {
  lastActivity = Date.now();
}

export function idleMinutes(): number {
  return (Date.now() - lastActivity) / 60_000;
}

async function installedModels(baseUrl: string): Promise<string[]> {
  if (baseUrl.startsWith("mock://")) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: controller.signal }).finally(() =>
      clearTimeout(timeout),
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

function record(
  loadoutId: string,
  trigger: FindingsRecord["trigger"],
  result: Awaited<ReturnType<typeof tune>>,
): FindingsRecord {
  const saved: FindingsRecord = {
    id: newId("find"),
    createdAt: new Date().toISOString(),
    loadoutId,
    trigger,
    baseline: result.baseline,
    findings: result.findings,
    ...(result.combined ? { combined: result.combined } : {}),
    tried: result.tried,
    cases: result.cases,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    // Unattended work is only worth doing if the answer is waiting afterwards.
    unseen: trigger !== "asked",
  };
  findings.save(saved);
  return saved;
}

export function startTunePass(loadoutId: string, trigger: FindingsRecord["trigger"], candidateModels: string[]) {
  const loadout = loadouts.get(loadoutId);
  if (!loadout) throw new Error("no such assistant");

  const config = settings.get();
  return startJob("tune", async (handle) => {
    const result = await tune({
      loadout,
      candidateModels,
      maxRuns: config.maxRunsPerPass,
      onProgress: handle.report,
      signal: handle.signal,
    });

    settings.save({ lastTuneAt: new Date().toISOString(), lastTuneCaseCount: result.cases });
    return record(loadout.id, trigger, result);
  });
}

/** One decision cycle. Deliberately does nothing in almost every case. */
async function tick(): Promise<void> {
  const config = settings.get();
  const loadout = loadouts.list()[0];
  if (!loadout) return;
  if (runningJob("tune") || runningJob("trial")) return;

  const known = new Set(config.knownModels ?? []);

  // Has anything new turned up on this machine?
  if (config.watchForNewModels && Date.now() - lastModelCheck > MODEL_CHECK_MS) {
    lastModelCheck = Date.now();
    const present = await installedModels(loadout.baseUrl);

    if (present.length) {
      const fresh = present.filter((m) => !known.has(m) && m !== loadout.model);
      settings.save({ knownModels: present });

      // First look just establishes what is here; it is not news that the
      // models someone already had exist.
      if (known.size && fresh.length && cases.list().length && idleMinutes() >= config.idleMinutes) {
        const model = fresh[0]!;
        startJob("trial", async (handle) => {
          handle.report(0, 1, `Checking ${model} against what you've taught it`);
          const replay = await runReplay({ model, loadoutRef: loadout.id });
          handle.report(1, 1, "Done");
          return replay;
        });
        return;
      }
    }
  }

  if (!config.autoTune) return;
  if (idleMinutes() < config.idleMinutes) return;

  const caseCount = cases.list().length;
  if (!caseCount) return;

  const since = caseCount - (config.lastTuneCaseCount ?? 0);
  if (config.lastTuneAt && since < config.tuneAfterLessons) return;

  const candidates = [...new Set([...(config.knownModels ?? [])])].filter((m) => m !== loadout.model);
  startTunePass(loadout.id, "idle", candidates);
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {
      // A failed decision cycle must never take the app down with it; the next
      // tick is a minute away.
    });
  }, TICK_MS);
  // Never hold the process open just to decide whether to do work.
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Exposed for the smoke test, which cannot wait a minute for a tick. */
export const _internals = { tick, installedModels };
