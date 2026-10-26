import { createHash } from "node:crypto";
import type { Budget } from "../../llm/src/index.js";
import { detectInjection, redact } from "../../scout/src/index.js";
export const EMBED_MODELS = [
  "nvidia/nemotron-3.5-embed-8b:free",
  "nvidia/nemotron-3.5-embed-1b:free",
] as const;
export interface Entry {
  id: string;
  title: string;
  description: string;
  columns: string[];
  url?: string;
}
export interface CacheKey {
  datasetId: string;
  metadataHash: string;
  model: string;
}
export interface VectorCache {
  get(key: CacheKey): Promise<number[] | undefined>;
  put(key: CacheKey, vector: number[]): Promise<void>;
}
export interface EmbeddingCall {
  requested: string;
  served?: string;
  ok: boolean;
  elapsedMs: number;
  inputs: number;
  tokens?: number;
  error?: string;
}
export interface EmbeddingProvider {
  embed(
    model: string,
    input: string[],
    signal: AbortSignal,
  ): Promise<{ vectors: number[][]; served: string; tokens?: number }>;
}
export interface RankResult {
  mode: "keyword" | "embedding";
  entries: Entry[];
  scores?: { id: string; score: number }[];
  model?: string;
  cacheHits: number;
  calls: number;
  reason?: string;
  elapsedMs: number;
}
export function metadataHash(entry: Entry) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: entry.title,
        description: entry.description,
        columns: [...entry.columns].sort(),
        url: entry.url ?? "",
      }),
    )
    .digest("hex");
}
export function validVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 32768 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    v.some((n) => n !== 0)
  );
}
export function cosine(a: number[], b: number[]) {
  if (!validVector(a) || !validVector(b) || a.length !== b.length)
    throw new Error("Invalid or mismatched embedding vectors");
  // Scaling first avoids overflow while retaining the cosine.
  const as = Math.max(...a.map(Math.abs)),
    bs = Math.max(...b.map(Math.abs));
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! / as,
      y = b[i]! / bs;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}
export class OpenRouterEmbeddings implements EmbeddingProvider {
  constructor(
    private key: string,
    private budget: Budget,
    private onCall?: (call: EmbeddingCall) => void | Promise<void>,
    private request: typeof fetch = fetch,
  ) {}
  async embed(model: string, input: string[], signal: AbortSignal) {
    if (!EMBED_MODELS.includes(model as (typeof EMBED_MODELS)[number]))
      throw new Error("Only the configured free Nemotron embedding routes are allowed");
    if (!input.length || input.length > 32 || input.some((s) => !s || s.length > 16000))
      throw new Error("Embedding input is empty or oversized");
    signal.throwIfAborted();
    if (!(await this.budget.take())) throw new Error("Embedding budget is exhausted");
    const start = Date.now();
    let served: string | undefined, tokens: number | undefined;
    try {
      const response = await this.request("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.key,
          "Content-Type": "application/json",
          "X-Title": "Fieldwork",
        },
        body: JSON.stringify({ model, input, encoding_format: "float" }),
        signal,
      });
      if (!response.ok) throw new Error("Embedding endpoint HTTP " + response.status);
      const body = (await response.json()) as {
        data?: { index: number; embedding: unknown }[];
        model?: string;
        usage?: { prompt_tokens?: number };
      };
      if (!Array.isArray(body.data) || body.data.length !== input.length)
        throw new Error("Embedding response count mismatch");
      const sorted = [...body.data].sort((a, b) => a.index - b.index);
      if (sorted.some((r, i) => r.index !== i || !validVector(r.embedding)))
        throw new Error("Invalid embedding response indices or vectors");
      const vectors = sorted.map((r) => r.embedding as number[]);
      if (vectors.some((v) => v.length !== vectors[0]!.length))
        throw new Error("Embedding dimensions differ");
      served = body.model ?? model;
      tokens = body.usage?.prompt_tokens;
      if (served.replace(/:free$/, "") !== model.replace(/:free$/, ""))
        throw new Error("Embedding model identity mismatch");
      await this.onCall?.({
        requested: model,
        served,
        ok: true,
        elapsedMs: Date.now() - start,
        inputs: input.length,
        tokens,
      });
      return { vectors, served, tokens };
    } catch (e) {
      await this.onCall?.({
        requested: model,
        served,
        ok: false,
        elapsedMs: Date.now() - start,
        inputs: input.length,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}
export class EmbeddingFinder {
  constructor(
    private opts: { enabled: boolean; cache: VectorCache; provider: EmbeddingProvider; timeoutMs?: number },
  ) {}
  async rank(question: string, entries: Entry[]): Promise<RankResult> {
    const start = Date.now(),
      fallback = (reason: string, calls = 0, cacheHits = 0): RankResult => ({
        mode: "keyword",
        entries,
        calls,
        cacheHits,
        reason,
        elapsedMs: Date.now() - start,
      });
    if (!this.opts.enabled) return fallback("Embedding ranking is disabled");
    if (!entries.length) return fallback("No keyword candidates");
    if (entries.length > 24 || new Set(entries.map((e) => e.id)).size !== entries.length)
      return fallback("Candidate set is invalid or too large");
    const texts = entries.map((e) =>
      JSON.stringify({ title: e.title, description: e.description, columns: [...e.columns].sort() }),
    );
    if (
      entries.some(
        (e, i) =>
          texts[i]!.length > 16000 ||
          detectInjection([e.title, e.description, ...e.columns].join("\n")).detected,
      )
    )
      return fallback("Candidate metadata requires inspection before embedding");
    const clean = redact(question).sanitized;
    if (!clean || clean.length > 16000) return fallback("Question is empty or oversized");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<RankResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Embedding ranking timed out"));
        resolve(fallback("Embedding ranking timed out", calls, hits));
      }, this.opts.timeoutMs ?? 12000);
    });
    let calls = 0,
      hits = 0,
      last = "Embedding routes unavailable";
    const work = async (): Promise<RankResult> => {
      for (const model of EMBED_MODELS) {
        try {
          controller.signal.throwIfAborted();
          const queryHash = createHash("sha256").update(clean).digest("hex");
          const keys: CacheKey[] = [
            { datasetId: "question:" + queryHash, metadataHash: queryHash, model },
            ...entries.map((e) => ({ datasetId: e.id, metadataHash: metadataHash(e), model })),
          ];
          const vectors: (number[] | undefined)[] = [];
          for (const key of keys) {
            controller.signal.throwIfAborted();
            const v = await this.opts.cache.get(key);
            vectors.push(validVector(v) ? v : undefined);
            if (validVector(v)) hits++;
          }
          const missing = keys.map((_, i) => i).filter((i) => !vectors[i]);
          if (missing.length) {
            calls++;
            const out = await this.opts.provider.embed(
              model,
              missing.map((i) => (i === 0 ? clean : texts[i - 1]!)),
              controller.signal,
            );
            controller.signal.throwIfAborted();
            if (out.vectors.length !== missing.length || out.vectors.some((v) => !validVector(v)))
              throw new Error("Embedding provider returned invalid vectors");
            for (let j = 0; j < missing.length; j++) {
              const i = missing[j]!;
              vectors[i] = out.vectors[j]!;
              await this.opts.cache.put(keys[i]!, out.vectors[j]!);
            }
          }
          const scored = entries
            .map((entry, i) => ({ entry, index: i, score: cosine(vectors[0]!, vectors[i + 1]!) }))
            .sort((a, b) => b.score - a.score || a.index - b.index);
          return {
            mode: "embedding",
            entries: scored.map((s) => s.entry),
            scores: scored.map((s) => ({ id: s.entry.id, score: s.score })),
            model,
            calls,
            cacheHits: hits,
            elapsedMs: Date.now() - start,
          };
        } catch (e) {
          last = (e as Error).message;
          if (controller.signal.aborted) break;
        }
      }
      return fallback(last, calls, hits);
    };
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
