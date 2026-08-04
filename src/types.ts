/**
 * The data model is the product.
 *
 * Everything here exists to answer one question: when a new open-weight model
 * drops, is it better than what I am running now *for the work I actually do*?
 * Public benchmarks cannot answer that. A record of your own accepted and
 * rejected outputs can.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages, links the result back to the request. */
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool as the model sees it. Its schema costs context, which is the point. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/**
 * A loadout is the harness: which model, what it is told, what it can reach
 * for, and what it already knows. Slots cost context, context is finite, and
 * an overloaded harness measurably degrades the model inside it.
 */
export interface Loadout {
  id: string;
  name: string;
  createdAt: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  /** Tool names, resolved against the built-in registry. */
  tools: string[];
  /** Files pinned into every prompt: style guides, project notes, glossaries. */
  memory: string[];
  params: SamplingParams;
  /** Declared usable context, in tokens. Denominator for encumbrance. */
  contextWindow: number;
}

/** Where the context budget went, before the task even starts. */
export interface Encumbrance {
  systemTokens: number;
  toolTokens: number;
  memoryTokens: number;
  total: number;
  contextWindow: number;
  /** Fraction of the window consumed by the harness itself, 0..1. */
  ratio: number;
  perTool: { name: string; tokens: number }[];
  perMemory: { path: string; tokens: number; missing: boolean }[];
}

export interface ToolCallRecord {
  name: string;
  arguments: string;
  result: string;
  ms: number;
  failed: boolean;
}

export interface RunStats {
  promptTokensEst: number;
  completionTokensEst: number;
  ms: number;
  tokensPerSec: number;
  encumbranceRatio: number;
}

/** One execution of one task under one loadout. */
export interface Run {
  id: string;
  createdAt: string;
  loadoutId: string;
  model: string;
  baseUrl: string;
  input: string;
  messages: Message[];
  output: string;
  toolCalls: ToolCallRecord[];
  stats: RunStats;
  error?: string;
}

export type VerdictKind = "accept" | "edit" | "reject";

/**
 * The human signal. This is the ground truth the whole system runs on, and it
 * is generated for free by using the tool normally. No synthetic rubric, no
 * hand-authored golden set.
 */
export interface Verdict {
  kind: VerdictKind;
  /** Present when kind === "edit": what the output should have been. */
  correctedOutput?: string;
  note?: string;
  at: string;
}

export type AssertionKind = "contains" | "not_contains" | "regex";

export interface Assertion {
  kind: AssertionKind;
  value: string;
  /** "auto" assertions were mined from an edit diff; "manual" were written. */
  source: "auto" | "manual";
  weight: number;
}

export type GraderKind = "exact" | "assertions" | "judge";

/** A run plus a verdict, promoted into something replayable. */
export interface EvalCase {
  id: string;
  createdAt: string;
  title: string;
  input: string;
  loadoutId: string;
  /** What good looks like: the accepted output, or the user's correction. */
  reference: string;
  origin: { runId: string; verdict: VerdictKind; model: string };
  assertions: Assertion[];
  graders: GraderKind[];
  /** Rejections are kept as negative references: do not produce this again. */
  antiReference?: string;
  tags: string[];
}

export interface GraderResult {
  grader: GraderKind;
  score: number;
  detail: string;
  /** Set when a grader could not run, e.g. no judge model configured. */
  skipped?: boolean;
}

export interface CaseResult {
  caseId: string;
  title: string;
  output: string;
  score: number;
  graders: GraderResult[];
  ms: number;
  tokensPerSec: number;
  error?: string;
}

export interface Replay {
  id: string;
  createdAt: string;
  model: string;
  baseUrl: string;
  loadoutId: string;
  results: CaseResult[];
  summary: {
    cases: number;
    scored: number;
    meanScore: number;
    medianTokensPerSec: number;
    failures: number;
  };
}
