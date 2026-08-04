import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_SETTINGS, type EvalCase, type FindingsRecord, type Loadout, type Replay, type Run, type Settings, type Verdict } from "./types.js";

/**
 * Flat JSON files on disk, one document per record. No database, no daemon.
 * A user should be able to open their eval suite in a text editor, diff it,
 * back it up, and delete a case they disagree with.
 */

const ROOT_ENV = "LOCALHARNESS_HOME";

export function homeDir(): string {
  const override = process.env[ROOT_ENV];
  return override ? resolve(override) : resolve(process.cwd(), ".localharness");
}

type Collection = "loadouts" | "runs" | "cases" | "replays" | "verdicts" | "findings";

function dirFor(c: Collection): string {
  return join(homeDir(), c);
}

export function ensureHome(): string {
  const root = homeDir();
  for (const c of ["loadouts", "runs", "cases", "replays", "verdicts", "findings"] as Collection[]) {
    mkdirSync(dirFor(c), { recursive: true });
  }
  return root;
}

export function isInitialized(): boolean {
  return existsSync(dirFor("loadouts"));
}

/** Short, sortable, human-typeable ids. Time prefix keeps listings ordered. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = randomBytes(3).toString("hex");
  return `${prefix}_${t}${r}`;
}

function pathFor(c: Collection, id: string): string {
  return join(dirFor(c), `${id}.json`);
}

function write<T>(c: Collection, id: string, value: T): T {
  mkdirSync(dirFor(c), { recursive: true });
  writeFileSync(pathFor(c, id), JSON.stringify(value, null, 2) + "\n", "utf8");
  return value;
}

function read<T>(c: Collection, id: string): T | undefined {
  const p = pathFor(c, id);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function list<T>(c: Collection): T[] {
  const dir = dirFor(c);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

export const loadouts = {
  save: (l: Loadout) => write("loadouts", l.id, l),
  get: (id: string) => read<Loadout>("loadouts", id),
  list: () => list<Loadout>("loadouts"),
  /** Accepts an id or a name, so the CLI can stay forgiving. */
  find(ref: string): Loadout | undefined {
    return this.get(ref) ?? this.list().find((l) => l.name === ref);
  },
};

export const runs = {
  save: (r: Run) => write("runs", r.id, r),
  get: (id: string) => read<Run>("runs", id),
  list: () => list<Run>("runs"),
};

export const cases = {
  save: (c: EvalCase) => write("cases", c.id, c),
  get: (id: string) => read<EvalCase>("cases", id),
  list: () => list<EvalCase>("cases"),
};

export const replays = {
  save: (r: Replay) => write("replays", r.id, r),
  get: (id: string) => read<Replay>("replays", id),
  list: () => list<Replay>("replays"),
};

export const verdicts = {
  save: (runId: string, v: Verdict) => write("verdicts", runId, v),
  get: (runId: string) => read<Verdict>("verdicts", runId),
};

function remove(c: Collection, id: string): boolean {
  const p = pathFor(c, id);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** Deleting is a first-class operation: you don't own what you can't change. */
export const cases_delete = (id: string) => remove("cases", id);

export const findings = {
  save: (f: FindingsRecord) => write("findings", f.id, f),
  get: (id: string) => read<FindingsRecord>("findings", id),
  list: () => list<FindingsRecord>("findings"),
  latest: () => list<FindingsRecord>("findings").at(-1),
  delete: (id: string) => remove("findings", id),
};

const SETTINGS_FILE = "settings.json";

export const settings = {
  get(): Settings {
    const p = join(homeDir(), SETTINGS_FILE);
    if (!existsSync(p)) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<Settings>) };
    } catch {
      // A corrupt settings file must not stop the app from opening.
      return { ...DEFAULT_SETTINGS };
    }
  },
  /**
   * Only known keys, only sane values.
   *
   * This is reachable over HTTP, and merging whatever arrives means a caller
   * can set `maxRunsPerPass` to a billion or write arbitrary keys into the
   * user's config file. Clamp the numbers that cost money and time, and drop
   * everything that isn't a real setting.
   */
  save(patch: Partial<Settings>): Settings {
    const current = this.get();
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

    const next: Settings = {
      autoTune: typeof patch.autoTune === "boolean" ? patch.autoTune : current.autoTune,
      watchForNewModels:
        typeof patch.watchForNewModels === "boolean" ? patch.watchForNewModels : current.watchForNewModels,
      tuneAfterLessons: clamp(patch.tuneAfterLessons, 1, 100, current.tuneAfterLessons),
      idleMinutes: clamp(patch.idleMinutes, 0, 24 * 60, current.idleMinutes),
      maxRunsPerPass: clamp(patch.maxRunsPerPass, 1, 5000, current.maxRunsPerPass),
      ...(patch.lastTuneAt ?? current.lastTuneAt ? { lastTuneAt: patch.lastTuneAt ?? current.lastTuneAt } : {}),
      ...(patch.lastTuneCaseCount ?? current.lastTuneCaseCount
        ? { lastTuneCaseCount: clamp(patch.lastTuneCaseCount, 0, 1e6, current.lastTuneCaseCount ?? 0) }
        : {}),
      ...(Array.isArray(patch.knownModels)
        ? { knownModels: patch.knownModels.filter((m) => typeof m === "string").slice(0, 200) }
        : current.knownModels
          ? { knownModels: current.knownModels }
          : {}),
    };

    mkdirSync(homeDir(), { recursive: true });
    writeFileSync(join(homeDir(), SETTINGS_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  },
};
