import {
  EmbeddingFinder,
  OpenRouterEmbeddings,
  type Entry,
  type EmbeddingCall,
} from "../../../packages/embeddings/src/index.js";
import { PostgresVectorCache } from "../../../packages/embeddings/src/postgres.js";
import type { Budget } from "@fieldwork/llm";
import { layerInfo, resolveLayerUrl, socrataColumns, type Candidate } from "@fieldwork/sources";
import type { Ctx } from "./agents/context.js";

export function makeFinderEmbeddings(
  ctx: Pick<Ctx, "cfg" | "db" | "trace">,
  budget: Budget,
): EmbeddingFinder | undefined {
  if (!ctx.cfg.finderEmbeddings || !ctx.cfg.openrouterKey) return;
  const onCall = async (call: EmbeddingCall) => {
    await ctx.trace.log({
      agent: "finder",
      action: "embedding_call",
      status: call.ok ? "ok" : "error",
      modelProvider: "openrouter",
      modelRequested: call.requested,
      modelServed: call.served,
      tokensIn: call.tokens,
      latencyMs: call.elapsedMs,
      note: JSON.stringify({ inputs: call.inputs, error: call.error }),
    });
  };
  return new EmbeddingFinder({
    enabled: true,
    cache: new PostgresVectorCache(ctx.db),
    provider: new OpenRouterEmbeddings(ctx.cfg.openrouterKey, budget, onCall),
  });
}

export async function rankFinderCandidates(
  ctx: Ctx,
  question: string,
  candidates: Candidate[],
): Promise<Candidate[]> {
  if (!ctx.cfg.finderEmbeddings || !ctx.finderEmbeddings) return candidates;
  const start = Date.now(),
    blocked = new Set<string>();
  try {
    const entries: Entry[] = [];
    // Read real schemas before ranking; timeout abandons ranking and keeps keyword order.
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
    try {
      for (const c of candidates) {
        const columns =
          c.fields ??
          (await Promise.race([
            c.kind === "arcgis_layer"
              ? resolveLayerUrl(c.url)
                  .then(layerInfo)
                  .then((info) => info.fields.flatMap((f) => [f.name, ...(f.alias ? [f.alias] : [])]))
              : c.kind === "socrata_resource"
                ? socrataColumns(c.url)
                : Promise.resolve([]),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(new Error("Candidate schema inspection timed out"));
              else
                controller.signal.addEventListener(
                  "abort",
                  () => reject(new Error("Candidate schema inspection timed out")),
                  { once: true },
                );
            }),
          ]));
        const metadata = { title: c.title, description: c.description, columns };
        if (ctx.scout && !(await ctx.scout.metadata(c, metadata))) {
          blocked.add(c.id);
          continue;
        }
        entries.push({ id: c.id, ...metadata, url: c.url });
      }
    } finally {
      clearTimeout(timer);
    }
    if (!entries.length) throw new Error("No candidates passed metadata inspection");
    const ranked = await ctx.finderEmbeddings.rank(question, entries);
    await ctx.trace.log({
      agent: "finder",
      action: "ranking",
      status: "info",
      note: JSON.stringify({
        mode: ranked.mode,
        model: ranked.model,
        cacheHits: ranked.cacheHits,
        calls: ranked.calls,
        elapsedMs: Date.now() - start,
        reason: ranked.reason,
        scores: ranked.scores,
      }),
    });
    const allowed = new Set(entries.map((e) => e.id));
    return ranked.mode === "embedding"
      ? ranked.entries.map((e) => candidates.find((c) => c.id === e.id)!)
      : candidates.filter((c) => allowed.has(c.id));
  } catch (e) {
    await ctx.trace.log({
      agent: "finder",
      action: "ranking",
      status: "info",
      note: JSON.stringify({ mode: "keyword", elapsedMs: Date.now() - start, reason: (e as Error).message }),
    });
    return candidates.filter((c) => !blocked.has(c.id));
  }
}
