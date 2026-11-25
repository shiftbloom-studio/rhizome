// SPDX-License-Identifier: AGPL-3.0-or-later
// The Workers AI binding on Node. rhizome makes three kinds of calls: embeddings
// ({ text }), chat ({ messages }) and reranking ({ query, contexts }). They go to
//
//   openai      any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM, LocalAI or OpenAI itself
//   cloudflare  Workers AI over its REST API, with the same models as the Worker
//
// Reranking is optional with "openai": without AI_RERANK_URL recall keeps its fused order.

export interface AiConfig {
  provider: "openai" | "cloudflare";
  /** openai: base URL including /v1, e.g. http://localhost:11434/v1 */
  baseUrl?: string;
  apiKey?: string;
  /** openai: a /rerank endpoint (Jina/Cohere style, served by llama.cpp, vLLM, TEI, Infinity, ...). */
  rerankUrl?: string;
  /** cloudflare: account id; apiKey is an API token with Workers AI read access. */
  accountId?: string;
  timeoutMs?: number;
}

type Input = {
  text?: string[] | string;
  messages?: { role: string; content: string }[];
  max_tokens?: number;
  temperature?: number;
  query?: string;
  contexts?: { text: string }[];
};

async function post(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

export class LocalAi {
  constructor(private cfg: AiConfig) {}

  async run(model: string, input: Input): Promise<unknown> {
    const timeout = this.cfg.timeoutMs ?? 180_000;
    if (this.cfg.provider === "cloudflare") {
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.cfg.accountId ?? "")}/ai/run/${model}`;
      const res = (await post(url, input, this.cfg.apiKey, timeout)) as { result?: unknown; success?: boolean };
      return res.result;
    }

    const base = (this.cfg.baseUrl ?? "").replace(/\/+$/, "");
    if (input.text !== undefined) {
      const texts = Array.isArray(input.text) ? input.text : [input.text];
      const res = (await post(`${base}/embeddings`, { model, input: texts }, this.cfg.apiKey, timeout)) as { data: { index: number; embedding: number[] }[] };
      return { data: [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding) };
    }
    if (input.query !== undefined && input.contexts) {
      if (!this.cfg.rerankUrl) throw new Error("no reranker configured (AI_RERANK_URL)");
      const res = (await post(this.cfg.rerankUrl, { model, query: input.query, documents: input.contexts.map((c) => c.text) }, this.cfg.apiKey, timeout)) as {
        results?: { index: number; relevance_score?: number; score?: number }[];
      };
      return { response: (res.results ?? []).map((r) => ({ id: r.index, score: r.relevance_score ?? r.score ?? 0 })) };
    }
    if (input.messages) {
      const res = (await post(
        `${base}/chat/completions`,
        { model, messages: input.messages, max_tokens: input.max_tokens, temperature: input.temperature },
        this.cfg.apiKey,
        timeout,
      )) as { choices?: { message?: { content?: string } }[] };
      // Reasoning models may wrap their thoughts in <think> tags before the answer.
      const content = (res.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return { response: content };
    }
    throw new Error(`unsupported AI input for ${model}`);
  }
}
