import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTokens, formatTokens, meter } from "./tokens.js";
import { resolveTools } from "./tools.js";
import { newId } from "./store.js";
import type { Encumbrance, Loadout, Message } from "./types.js";

/**
 * Encumbrance is the design spine.
 *
 * In a game, a loadout is interesting because slots are scarce. Here the
 * scarcity is not invented: every tool schema, every pinned note, every line
 * of system prompt is consumed from the same context window the task needs.
 * Equipping is a real tradeoff, so it is worth making it visible.
 */

export const DEFAULT_BASE_URL = process.env.LOCALHARNESS_BASE_URL ?? "http://localhost:11434/v1";

export function createLoadout(init: Partial<Loadout> & { name: string }): Loadout {
  return {
    id: init.id ?? newId("ld"),
    name: init.name,
    createdAt: init.createdAt ?? new Date().toISOString(),
    model: init.model ?? "qwen2.5-coder:7b",
    baseUrl: init.baseUrl ?? DEFAULT_BASE_URL,
    // A first-run default a person can read and edit, not a developer's stub.
    systemPrompt:
      init.systemPrompt ??
      "Answer in plain language, as briefly as the question allows. " +
        "If you aren't sure of something, say so rather than guessing.",
    tools: init.tools ?? [],
    memory: init.memory ?? [],
    params: init.params ?? { temperature: 0.2 },
    contextWindow: init.contextWindow ?? 8192,
  };
}

export function readMemory(path: string, cwd = process.cwd()): { text: string; missing: boolean } {
  const full = resolve(cwd, path);
  if (!existsSync(full)) return { text: "", missing: true };
  try {
    return { text: readFileSync(full, "utf8"), missing: false };
  } catch {
    return { text: "", missing: true };
  }
}

export function computeEncumbrance(loadout: Loadout, cwd = process.cwd()): Encumbrance {
  const systemTokens = estimateTokens(loadout.systemPrompt);

  const perTool = resolveTools(loadout.tools).map((t) => ({
    name: t.spec.name,
    // The model is billed for the serialized schema, so measure that.
    tokens: estimateTokens(JSON.stringify(t.spec)),
  }));
  const toolTokens = perTool.reduce((s, t) => s + t.tokens, 0);

  const perMemory = loadout.memory.map((path) => {
    const { text, missing } = readMemory(path, cwd);
    return { path, tokens: estimateTokens(text), missing };
  });
  const memoryTokens = perMemory.reduce((s, m) => s + m.tokens, 0);

  const total = systemTokens + toolTokens + memoryTokens;
  return {
    systemTokens,
    toolTokens,
    memoryTokens,
    total,
    contextWindow: loadout.contextWindow,
    ratio: loadout.contextWindow > 0 ? total / loadout.contextWindow : 0,
    perTool,
    perMemory,
  };
}

/** Assemble the system message the loadout implies, memory files included. */
export function buildSystemMessage(loadout: Loadout, cwd = process.cwd()): Message {
  const blocks: string[] = [loadout.systemPrompt];
  for (const path of loadout.memory) {
    const { text, missing } = readMemory(path, cwd);
    if (missing) continue;
    blocks.push(`<memory path="${path}">\n${text.trim()}\n</memory>`);
  }
  return { role: "system", content: blocks.join("\n\n") };
}

export function describeEncumbrance(loadout: Loadout, cwd = process.cwd()): string {
  const e = computeEncumbrance(loadout, cwd);
  const lines: string[] = [];
  const pct = (e.ratio * 100).toFixed(1);

  lines.push(`${loadout.name}  (${loadout.id})`);
  lines.push(`  model     ${loadout.model}  @ ${loadout.baseUrl}`);
  lines.push(
    `  context   ${meter(e.ratio)} ${pct}% used by harness ` +
      `(${formatTokens(e.total)} / ${formatTokens(e.contextWindow)})`,
  );
  lines.push(`  free      ${formatTokens(Math.max(0, e.contextWindow - e.total))} tokens for the actual task`);
  lines.push(`  system    ${formatTokens(e.systemTokens)}`);

  if (e.perTool.length) {
    lines.push(`  tools     ${formatTokens(e.toolTokens)}`);
    for (const t of e.perTool) lines.push(`    - ${t.name.padEnd(14)} ${formatTokens(t.tokens)}`);
  } else {
    lines.push(`  tools     none equipped`);
  }

  if (e.perMemory.length) {
    lines.push(`  memory    ${formatTokens(e.memoryTokens)}`);
    for (const m of e.perMemory) {
      lines.push(`    - ${m.path.padEnd(14)} ${m.missing ? "MISSING" : formatTokens(m.tokens)}`);
    }
  } else {
    lines.push(`  memory    nothing pinned`);
  }

  if (e.ratio > 0.5) {
    lines.push(`  ! over half the window is gone before the task starts.`);
  }
  return lines.join("\n");
}
