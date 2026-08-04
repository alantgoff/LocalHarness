import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ToolSpec } from "./types.js";

/**
 * A small registry of read-only tools.
 *
 * They are real (the model can call them and get true answers about the
 * working directory) but deliberately harmless: nothing here writes, deletes,
 * or reaches the network. Capture is supposed to be safe to leave running.
 *
 * Every tool is also a context cost. The registry exists so that equipping one
 * has a price the user can see.
 */

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, cwd: string): Promise<string>;
}

const MAX_RESULT_CHARS = 4000;

function clip(s: string): string {
  return s.length <= MAX_RESULT_CHARS
    ? s
    : `${s.slice(0, MAX_RESULT_CHARS)}\n... [truncated, ${s.length - MAX_RESULT_CHARS} more characters]`;
}

/** Refuse anything that escapes the working directory. */
function safeResolve(cwd: string, p: string): string {
  const target = resolve(cwd, p);
  const rel = relative(cwd, target);
  if (rel.startsWith("..")) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return target;
}

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required string argument: ${key}`);
}

const readFile: Tool = {
  spec: {
    name: "read_file",
    description: "Read a UTF-8 text file from the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working directory." },
      },
      required: ["path"],
    },
  },
  async run(args, cwd) {
    const p = safeResolve(cwd, str(args, "path"));
    if (!existsSync(p)) return `No such file: ${str(args, "path")}`;
    return clip(readFileSync(p, "utf8"));
  },
};

const listFiles: Tool = {
  spec: {
    name: "list_files",
    description: "List files and directories at a path in the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory, relative to the working directory. Defaults to '.'." },
      },
    },
  },
  async run(args, cwd) {
    const rel = str(args, "path", ".");
    const p = safeResolve(cwd, rel);
    if (!existsSync(p)) return `No such directory: ${rel}`;
    const entries = readdirSync(p)
      .filter((e) => !e.startsWith("."))
      .slice(0, 200)
      .map((e) => (statSync(join(p, e)).isDirectory() ? `${e}/` : e));
    return clip(entries.join("\n") || "(empty)");
  },
};

const searchText: Tool = {
  spec: {
    name: "search_text",
    description: "Find files under the working directory whose contents match a case-insensitive substring.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for." },
        path: { type: "string", description: "Directory to search under. Defaults to '.'." },
      },
      required: ["query"],
    },
  },
  async run(args, cwd) {
    const query = str(args, "query").toLowerCase();
    const root = safeResolve(cwd, str(args, "path", "."));
    const hits: string[] = [];
    const skip = new Set(["node_modules", "dist", ".git", ".localharness"]);

    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || hits.length >= 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.startsWith(".") || skip.has(e)) continue;
        const full = join(dir, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (st.size < 512_000) {
          try {
            const body = readFileSync(full, "utf8");
            const idx = body.toLowerCase().indexOf(query);
            if (idx >= 0) {
              const line = body.slice(0, idx).split("\n").length;
              hits.push(`${relative(cwd, full)}:${line}`);
            }
          } catch {
            // Binary or unreadable; not an error worth surfacing to the model.
          }
        }
        if (hits.length >= 50) return;
      }
    };

    walk(root, 0);
    return clip(hits.join("\n") || "No matches.");
  },
};

export const REGISTRY: Record<string, Tool> = {
  read_file: readFile,
  list_files: listFiles,
  search_text: searchText,
};

export function resolveTools(names: string[]): Tool[] {
  return names.map((n) => {
    const t = REGISTRY[n];
    if (!t) {
      throw new Error(
        `unknown tool "${n}". Available: ${Object.keys(REGISTRY).join(", ")}`,
      );
    }
    return t;
  });
}

export function toolNames(): string[] {
  return Object.keys(REGISTRY);
}
