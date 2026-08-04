import { buildSystemMessage, computeEncumbrance } from "./loadout.js";
import { createProvider } from "./provider.js";
import { newId } from "./store.js";
import { estimateMessageTokens, estimateTokens } from "./tokens.js";
import { resolveTools } from "./tools.js";
import type { Loadout, Message, Run, ToolCallRecord } from "./types.js";

const MAX_TOOL_ROUNDS = 6;

export interface RunOptions {
  /** Override the loadout's model, which is exactly what replay does. */
  model?: string;
  baseUrl?: string;
  cwd?: string;
  onEvent?: (line: string) => void;
}

/**
 * Execute one task under one loadout and record everything about it.
 *
 * The record is the point. A run that is never graded is still worth keeping:
 * it is the raw material a case is promoted from, and it carries the timing
 * and context numbers that make a later model comparison fair.
 */
export async function executeRun(
  loadout: Loadout,
  input: string,
  opts: RunOptions = {},
): Promise<Run> {
  const cwd = opts.cwd ?? process.cwd();
  const model = opts.model ?? loadout.model;
  const baseUrl = opts.baseUrl ?? loadout.baseUrl;
  const provider = createProvider(baseUrl);
  const tools = resolveTools(loadout.tools);
  const specs = tools.map((t) => t.spec);
  const encumbrance = computeEncumbrance(loadout, cwd);

  const messages: Message[] = [buildSystemMessage(loadout, cwd), { role: "user", content: input }];
  const toolCallRecords: ToolCallRecord[] = [];

  const started = Date.now();
  let output = "";
  let error: string | undefined;
  let completionTokens = 0;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await provider.chat({ model, messages, tools: specs, params: loadout.params });
      completionTokens += res.completionTokens ?? estimateTokens(res.content);

      if (!res.toolCalls.length) {
        output = res.content;
        messages.push({ role: "assistant", content: res.content });
        break;
      }

      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });

      if (round === MAX_TOOL_ROUNDS) {
        // Out of rounds with tools still pending. Keep whatever prose exists
        // rather than discarding the run: a truncated answer is still a
        // gradeable data point about this harness.
        output = res.content;
        error = `tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`;
        break;
      }

      for (const call of res.toolCalls) {
        const tool = tools.find((t) => t.spec.name === call.name);
        const t0 = Date.now();
        let result: string;
        let failed = false;

        if (!tool) {
          result = `Error: no such tool "${call.name}".`;
          failed = true;
        } else {
          try {
            const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
            result = await tool.run(args, cwd);
          } catch (e) {
            result = `Error: ${(e as Error).message}`;
            failed = true;
          }
        }

        const record: ToolCallRecord = {
          name: call.name,
          arguments: call.arguments,
          result,
          ms: Date.now() - t0,
          failed,
        };
        toolCallRecords.push(record);
        opts.onEvent?.(`  ${failed ? "x" : ">"} ${call.name}(${call.arguments}) ${record.ms}ms`);

        messages.push({ role: "tool", content: result, toolCallId: call.id, name: call.name });
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const ms = Date.now() - started;
  const promptTokensEst = estimateMessageTokens(messages.map((m) => m.content));

  return {
    id: newId("run"),
    createdAt: new Date().toISOString(),
    loadoutId: loadout.id,
    model,
    baseUrl,
    input,
    messages,
    output,
    toolCalls: toolCallRecords,
    stats: {
      promptTokensEst,
      completionTokensEst: completionTokens,
      ms,
      tokensPerSec: ms > 0 ? (completionTokens / ms) * 1000 : 0,
      encumbranceRatio: encumbrance.ratio,
    },
    ...(error ? { error } : {}),
  };
}
