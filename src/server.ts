import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tune } from "./autotune.js";
import { promoteToCase } from "./capture.js";
import { cancelJob, getJob, listJobs, runningJob, startJob } from "./jobs.js";
import { computeEncumbrance, createLoadout, DEFAULT_BASE_URL } from "./loadout.js";
import { runReplay } from "./replay.js";
import { executeRun } from "./runner.js";
import { cases, ensureHome, loadouts, replays, runs } from "./store.js";
import { REGISTRY } from "./tools.js";
import { estimateTokens } from "./tokens.js";
import type { Loadout, Verdict } from "./types.js";

/**
 * A local HTTP server so the harness has a face.
 *
 * The CLI proved the loop works. It cannot make the loop *happen*, because a
 * command you have to remember to run is a command you stop running by week
 * three. Capture has to sit where the work is, and it has to cost one click.
 */

const UI_ROOT = resolve(fileURLToPath(new URL("../ui", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Local-only tool, but there is no reason for anything to embed it.
    "x-frame-options": "DENY",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Loadouts leave here with their cost already computed; the UI never guesses. */
function withEncumbrance(l: Loadout) {
  return { ...l, encumbrance: computeEncumbrance(l) };
}

function toolCatalogue() {
  return Object.values(REGISTRY).map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    tokens: estimateTokens(JSON.stringify(t.spec)),
  }));
}

function snapshot() {
  return {
    loadouts: loadouts.list().map(withEncumbrance),
    tools: toolCatalogue(),
    cases: cases.list(),
    replays: replays.list().map((r) => ({ ...r, results: r.results })),
    jobs: listJobs(),
  };
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";

  if (path === "/api/state" && method === "GET") {
    sendJson(res, 200, snapshot());
    return true;
  }

  /**
   * Is anything actually serving models on this machine?
   *
   * This is the question that decides whether a newcomer gets anywhere at all,
   * and it deserves a real answer rather than a failed task ten screens later.
   * The model list doubles as the brain picker: showing what someone has
   * installed beats showing a catalogue of things they don't.
   */
  if (path === "/api/health" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const baseUrl = url.searchParams.get("baseUrl") ?? loadouts.list()[0]?.baseUrl ?? DEFAULT_BASE_URL;

    if (baseUrl.startsWith("mock://")) {
      sendJson(res, 200, { ok: true, baseUrl, models: ["mock-model"], mock: true });
      return true;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const probe = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        signal: controller.signal,
        headers: process.env.LOCALHARNESS_API_KEY
          ? { authorization: `Bearer ${process.env.LOCALHARNESS_API_KEY}` }
          : {},
      }).finally(() => clearTimeout(timer));

      if (!probe.ok) {
        sendJson(res, 200, { ok: false, baseUrl, models: [], error: `the server answered with ${probe.status}` });
        return true;
      }
      const json = (await probe.json()) as { data?: { id?: string }[] };
      const models = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
      sendJson(res, 200, { ok: true, baseUrl, models });
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? "it didn't answer in time" : "nothing is listening there";
      sendJson(res, 200, { ok: false, baseUrl, models: [], error: reason });
    }
    return true;
  }

  if (path === "/api/loadouts" && method === "POST") {
    const body = await readBody(req);
    const name = str(body, "name");
    if (!name) {
      sendJson(res, 400, { error: "a loadout needs a name" });
      return true;
    }
    const l = createLoadout({
      name,
      ...(str(body, "model") ? { model: str(body, "model")! } : {}),
      ...(str(body, "baseUrl") ? { baseUrl: str(body, "baseUrl")! } : {}),
      ...(str(body, "systemPrompt") ? { systemPrompt: str(body, "systemPrompt")! } : {}),
      ...(typeof body.contextWindow === "number" ? { contextWindow: body.contextWindow } : {}),
    });
    loadouts.save(l);
    sendJson(res, 200, withEncumbrance(l));
    return true;
  }

  const patchMatch = path.match(/^\/api\/loadouts\/([^/]+)$/);
  if (patchMatch && method === "PATCH") {
    const l = loadouts.get(patchMatch[1]!);
    if (!l) {
      sendJson(res, 404, { error: "no such loadout" });
      return true;
    }
    const body = await readBody(req);
    if (Array.isArray(body.tools)) {
      const unknown = (body.tools as string[]).filter((t) => !REGISTRY[t]);
      if (unknown.length) {
        sendJson(res, 400, { error: `unknown tool: ${unknown.join(", ")}` });
        return true;
      }
      l.tools = body.tools as string[];
    }
    if (Array.isArray(body.memory)) l.memory = body.memory as string[];
    // Findings from a tuning pass can carry sampling changes, so they have to
    // be appliable through the same path a person edits by hand.
    if (body.params && typeof body.params === "object") {
      l.params = { ...l.params, ...(body.params as Loadout["params"]) };
    }
    if (typeof body.systemPrompt === "string") l.systemPrompt = body.systemPrompt;
    if (typeof body.model === "string") l.model = body.model;
    if (typeof body.baseUrl === "string") l.baseUrl = body.baseUrl;
    if (typeof body.contextWindow === "number") l.contextWindow = body.contextWindow;
    if (typeof body.name === "string") l.name = body.name;
    loadouts.save(l);
    sendJson(res, 200, withEncumbrance(l));
    return true;
  }

  if (path === "/api/run" && method === "POST") {
    const body = await readBody(req);
    const loadoutId = str(body, "loadoutId");
    const input = str(body, "input");
    if (!loadoutId || !input) {
      sendJson(res, 400, { error: "need a loadout and a task" });
      return true;
    }
    const l = loadouts.get(loadoutId);
    if (!l) {
      sendJson(res, 404, { error: "no such loadout" });
      return true;
    }
    const run = await executeRun(l, input, {
      ...(str(body, "model") ? { model: str(body, "model")! } : {}),
    });
    runs.save(run);
    sendJson(res, 200, run);
    return true;
  }

  if (path === "/api/capture" && method === "POST") {
    const body = await readBody(req);
    const runId = str(body, "runId");
    const kind = str(body, "kind");
    if (!runId || !kind || !["accept", "edit", "reject"].includes(kind)) {
      sendJson(res, 400, { error: "need a run and a verdict of accept, edit or reject" });
      return true;
    }
    const run = runs.get(runId);
    if (!run) {
      sendJson(res, 404, { error: "no such run" });
      return true;
    }
    const verdict: Verdict = {
      kind: kind as Verdict["kind"],
      ...(str(body, "correctedOutput") ? { correctedOutput: str(body, "correctedOutput")! } : {}),
      ...(str(body, "note") ? { note: str(body, "note")! } : {}),
      at: new Date().toISOString(),
    };
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
    sendJson(res, 200, promoteToCase(run, verdict, tags));
    return true;
  }

  // Tuning is minutes of model calls, so it starts a job and returns at once.
  if (path === "/api/tune" && method === "POST") {
    const existing = runningJob("tune");
    if (existing) {
      sendJson(res, 200, existing);
      return true;
    }

    const body = await readBody(req);
    const loadout = loadouts.get(str(body, "loadoutId") ?? "") ?? loadouts.list()[0];
    if (!loadout) {
      sendJson(res, 404, { error: "no assistant set up yet" });
      return true;
    }

    const models = Array.isArray(body.candidateModels) ? (body.candidateModels as string[]) : [];
    const job = startJob("tune", (handle) =>
      tune({
        loadout,
        candidateModels: models,
        ...(typeof body.maxCandidates === "number" ? { maxCandidates: body.maxCandidates } : {}),
        onProgress: handle.report,
        signal: handle.signal,
      }),
    );
    sendJson(res, 200, job);
    return true;
  }

  if (path === "/api/jobs" && method === "GET") {
    sendJson(res, 200, listJobs());
    return true;
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") {
    const job = getJob(jobMatch[1]!);
    if (!job) {
      sendJson(res, 404, { error: "no such job" });
      return true;
    }
    sendJson(res, 200, job);
    return true;
  }
  if (jobMatch && method === "DELETE") {
    sendJson(res, 200, { cancelled: cancelJob(jobMatch[1]!) });
    return true;
  }

  if (path === "/api/replay" && method === "POST") {
    const body = await readBody(req);
    const model = str(body, "model");
    if (!model) {
      sendJson(res, 400, { error: "which model should the suite run against?" });
      return true;
    }
    const replay = await runReplay({
      model,
      ...(str(body, "baseUrl") ? { baseUrl: str(body, "baseUrl")! } : {}),
      ...(str(body, "loadoutRef") ? { loadoutRef: str(body, "loadoutRef")! } : {}),
    });
    sendJson(res, 200, replay);
    return true;
  }

  return false;
}

function serveStatic(res: ServerResponse, path: string): void {
  const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
  const file = join(UI_ROOT, rel);

  if (!file.startsWith(UI_ROOT) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  res.end(body);
}

/** Resolves with the port actually bound, which matters when passed 0. */
export function startServer(port: number): Promise<number> {
  ensureHome();

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    handleApi(req, res, path)
      .then((handled) => {
        if (handled) return;
        if (path.startsWith("/api/")) {
          sendJson(res, 404, { error: `no such endpoint: ${path}` });
          return;
        }
        serveStatic(res, path);
      })
      .catch((e: Error) => {
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
        else res.end();
      });
  });

  // Bind to loopback only. This exposes the filesystem through read tools and
  // has no auth; it has no business being reachable from the network.
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      ok(typeof address === "object" && address ? address.port : port);
    });
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("server.js");
if (invokedDirectly) {
  const portFlag = process.argv.indexOf("--port");
  startServer(portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173).then((p) =>
    process.stdout.write(`localharness ui  ->  http://localhost:${p}\n`),
  );
}
