import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { EvalCase, Loadout, Replay, Run, Verdict } from "./types.js";

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

type Collection = "loadouts" | "runs" | "cases" | "replays" | "verdicts";

function dirFor(c: Collection): string {
  return join(homeDir(), c);
}

export function ensureHome(): string {
  const root = homeDir();
  for (const c of ["loadouts", "runs", "cases", "replays", "verdicts"] as Collection[]) {
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
