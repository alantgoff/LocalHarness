import { createHash } from "node:crypto";
import type { Message, SamplingParams, ToolCall, ToolSpec } from "./types.js";

/**
 * One client for every endpoint worth targeting.
 *
 * Ollama, LM Studio, llama.cpp's server, vLLM, OpenRouter, Together and
 * Fireworks all speak the OpenAI chat-completions shape. Committing to that
 * shape means "local" is a deployment choice rather than a hard requirement:
 * the same loadout runs against a model on the user's GPU or a hosted
 * open-weight endpoint, and the eval suite does not care which.
 */

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  params: SamplingParams;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

function toWire(m: Message): WireMessage {
  const out: WireMessage = { role: m.role, content: m.content || null };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.name) out.name = m.name;
  return out;
}

class OpenAICompatibleProvider implements Provider {
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWire),
      stream: false,
    };
    if (req.params.temperature !== undefined) body.temperature = req.params.temperature;
    if (req.params.topP !== undefined) body.top_p = req.params.topP;
    if (req.params.maxTokens !== undefined) body.max_tokens = req.params.maxTokens;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} from ${url}${text ? `: ${text.slice(0, 400)}` : ""}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: WireMessage }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error(`no choices in response from ${url}`);

    return {
      content: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    };
  }
}

/**
 * A deterministic offline provider, addressed as `mock://<flavour>`.
 *
 * The capture -> case -> replay loop is the thing being proven, and it should
 * be testable without a GPU, a download, or a network call. Scripted responses
 * come from LOCALHARNESS_MOCK_SCRIPT: a JSON object mapping "model::substring"
 * or "substring" to the reply to return.
 */
class MockProvider implements Provider {
  private script: Record<string, string>;

  constructor(private flavour: string) {
    const raw = process.env.LOCALHARNESS_MOCK_SCRIPT;
    let parsed: Record<string, string> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, string>;
      } catch {
        throw new Error("LOCALHARNESS_MOCK_SCRIPT is not valid JSON");
      }
    }
    this.script = parsed;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";

    for (const [key, reply] of Object.entries(this.script)) {
      const [modelPart, textPart] = key.includes("::") ? key.split("::", 2) : [undefined, key];
      if (modelPart !== undefined && modelPart !== req.model) continue;
      if (textPart && prompt.toLowerCase().includes(textPart.toLowerCase())) {
        return { content: reply, toolCalls: [] };
      }
    }

    const digest = createHash("sha256").update(`${this.flavour}:${req.model}:${prompt}`).digest("hex");
    return {
      content: `[mock:${req.model}] ${prompt.slice(0, 200)}\ndigest=${digest.slice(0, 12)}`,
      toolCalls: [],
    };
  }
}

export function isMock(baseUrl: string): boolean {
  return baseUrl.startsWith("mock://");
}

export function createProvider(baseUrl: string): Provider {
  if (isMock(baseUrl)) return new MockProvider(baseUrl.slice("mock://".length) || "default");
  const key =
    process.env.LOCALHARNESS_API_KEY ??
    process.env.OPENAI_API_KEY ??
    // Local servers ignore the header but some proxies require it to be present.
    (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") ? "local" : undefined);
  return new OpenAICompatibleProvider(baseUrl, key);
}
