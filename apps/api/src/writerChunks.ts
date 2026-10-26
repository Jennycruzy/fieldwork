import { createHash } from "node:crypto";
import { z } from "zod";
import { checkDraft, type CheckResult, type Plan } from "@fieldwork/core";
import { Markovian, type MarkovianRun } from "../../../packages/markovian/src/index.js";
import { systemBase, dataBlock, type Ctx } from "./agents/context.js";
import type { Joined } from "./agents/joiner.js";
export interface ChunkFact {
  row_index: number;
  text: string;
}
export interface WriterChunkState {
  signature: string;
  engine: MarkovianRun;
  facts: ChunkFact[];
}
const schema = z.object({
  facts: z
    .array(z.object({ row_index: z.number().int().nonnegative(), text: z.string().min(1).max(160) }))
    .max(2),
});
const rankOrAggregate =
  /\b(highest|lowest|most|fewest|rank(?:ed|ing)?|first|second|third|total|sum|all|every)\b/i;
export async function writerChunks(
  ctx: Ctx,
  question: string,
  plan: Plan,
  joined: Joined,
  checks: CheckResult[],
): Promise<WriterChunkState | undefined> {
  const rows = joined.result.rows,
    headers = joined.result.headers;
  if (
    !ctx.cfg?.markovianWriter ||
    plan.geography !== "tract" ||
    plan.analysis?.relationship ||
    rows.length <= 40
  )
    return;
  const signature = createHash("sha256")
    .update(joined.sql + JSON.stringify(rows))
    .digest("hex");
  if (ctx.writerChunkState?.signature === signature) return ctx.writerChunkState;
  const count = Math.ceil(rows.length / 40),
    details = checks.map((c) => c.detail);
  if (count > 3) return;
  let step = 0;
  const engine = new Markovian({
    chunkConfig: { chunkSize: 6000, maxChunks: count, carryoverTokens: 512, overlapTokens: 0 },
  });
  const run = await engine.run({
    goal: "Choose checked row facts for this question: " + question,
    reflect: false,
    generator: async (prompt, _attachments, system) => {
      const offset = step++ * 40,
        chunk = rows.slice(offset, offset + 40);
      const carriedText = prompt.match(/\nCONTEXT: ([^\n]*)/)?.[1];
      let carried: ChunkFact[] = [];
      if (carriedText) {
        const parsed = z.array(schema.shape.facts.element).safeParse(JSON.parse(carriedText));
        if (parsed.success) carried = parsed.data;
      }
      const reply = await ctx.models.writer.json(
        [
          {
            role: "system",
            content:
              systemBase(ctx) +
              "\nProduce at most two short facts about individual named rows in this bounded data chunk. Copy numeric row cells exactly. Return their global row_index. Do not use ranks, extrema, totals or cohort sizes; those are supplied separately by code. Avoid repeating carried facts. This JSON adapter supplies state/completion markers, so return only {facts:[{row_index:0,text:...}]}.",
          },
          {
            role: "user",
            content:
              dataBlock("engine_state", prompt) +
              "\n" +
              dataBlock("engine_mode", system ?? "") +
              "\n" +
              dataBlock("chunk_rows", {
                headers,
                rows: chunk.map((r, i) => ({ row_index: offset + i, cells: r })),
              }),
          },
        ],
        schema,
        700,
      );
      const verified: ChunkFact[] = [];
      for (const fact of reply.value.facts) {
        const row = rows[fact.row_index];
        const inChunk = fact.row_index >= offset && fact.row_index < offset + chunk.length;
        const ok =
          inChunk &&
          row &&
          !rankOrAggregate.test(fact.text) &&
          checkDraft([fact.text], headers, [row], details).ok &&
          checkDraft([fact.text], headers, rows, details).ok;
        if (ok) verified.push(fact);
        else
          await ctx.trace.log({
            agent: "writer",
            action: "markovian_rejected",
            status: "info",
            note: JSON.stringify({
              text: fact.text,
              row_index: fact.row_index,
              reason: "The row fact did not pass the existing answer checks",
            }),
          });
      }
      const facts = [...carried, ...verified].filter(
        (f, i, a) => a.findIndex((x) => x.text === f.text) === i,
      );
      const state =
        "COMPLETED: reviewed rows through " +
        (offset + chunk.length) +
        "\nREMAINING: " +
        (rows.length - offset - chunk.length) +
        " rows\nDECISIONS: keep only row-checked facts\nCONTEXT: " +
        JSON.stringify(facts);
      const done = step === count;
      const output = JSON.stringify(facts) + (done ? "\n[TASK_COMPLETE]" : "\n[STATE_CHECKPOINT]\n" + state);
      const calls = reply.calls ?? [],
        tokens = calls.reduce((n, c) => n + c.tokensOut, 0);
      return { text: output, ...(calls.length ? { metadata: { usage: { output_tokens: tokens } } } : {}) };
    },
    onChunk: async (chunk) => {
      await ctx.trace.log({
        agent: "writer",
        action: "markovian_chunk",
        status: "info",
        note: JSON.stringify({ engine: "Markovian", chunk, carryover_limit: 512, efficiency: "modeled" }),
      });
    },
  });
  let facts: ChunkFact[] = [];
  if (run.status === "completed") {
    const parsed = z
      .array(schema.shape.facts.element)
      .safeParse(JSON.parse(run.chunks.at(-1)?.content ?? "[]"));
    if (parsed.success) facts = parsed.data.filter((f) => checkDraft([f.text], headers, rows, details).ok);
  }
  const result = { signature, engine: run, facts };
  ctx.writerChunkState = result;
  await ctx.trace.log({
    agent: "writer",
    action: "markovian_summary",
    status: run.status === "completed" ? "ok" : "error",
    note: JSON.stringify({
      status: run.status,
      chunks: run.chunks.length,
      facts: facts.length,
      tokens: run.totalTokensUsed,
      token_label: run.tokenLabel,
      efficiency_label: run.efficiencyLabel,
      error: run.error,
    }),
  });
  return result;
}
