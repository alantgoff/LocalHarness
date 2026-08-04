import { newId } from "./store.js";

/**
 * Work that outlives the request that asked for it.
 *
 * A tuning pass is minutes of model calls, not milliseconds. The user should
 * be able to start one, close the window, make coffee, and find the answer
 * waiting — so the HTTP request that starts a job returns immediately and the
 * job reports progress to anyone who asks.
 *
 * In-process and in-memory on purpose. Persisting job state would mean
 * resuming half-finished tuning passes across restarts, and a half-scored
 * comparison is worse than no comparison.
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  progress: { done: number; total: number; note: string };
  result?: T;
  error?: string;
}

export interface JobHandle {
  report: (done: number, total: number, note: string) => void;
  signal: { aborted: boolean };
}

const jobs = new Map<string, Job>();
const signals = new Map<string, { aborted: boolean }>();

/** Keep the list short; a laptop app has no business hoarding history. */
const MAX_KEPT = 20;

function prune(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));
  while (jobs.size > MAX_KEPT && finished.length) {
    const oldest = finished.shift();
    if (oldest) {
      jobs.delete(oldest.id);
      signals.delete(oldest.id);
    }
  }
}

export function startJob<T>(kind: string, work: (handle: JobHandle) => Promise<T>): Job<T> {
  const id = newId("job");
  const signal = { aborted: false };
  const job: Job<T> = {
    id,
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { done: 0, total: 0, note: "Starting" },
  };

  jobs.set(id, job as Job);
  signals.set(id, signal);

  const handle: JobHandle = {
    report: (done, total, note) => {
      job.progress = { done, total, note };
    },
    signal,
  };

  work(handle)
    .then((result) => {
      job.result = result;
      job.status = signal.aborted ? "cancelled" : "done";
    })
    .catch((e: Error) => {
      job.error = e.message;
      job.status = "failed";
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      prune();
    });

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function runningJob(kind: string): Job | undefined {
  return [...jobs.values()].find((j) => j.kind === kind && j.status === "running");
}

export function cancelJob(id: string): boolean {
  const signal = signals.get(id);
  const job = jobs.get(id);
  if (!signal || !job || job.status !== "running") return false;
  signal.aborted = true;
  job.progress.note = "Stopping";
  return true;
}
