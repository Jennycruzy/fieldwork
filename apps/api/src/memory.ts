// What a run teaches Fieldwork, written to H-MEM at the end of the run.

import { feedback, remember, saveMemory, slug } from "@fieldwork/hmem";
import type { Ctx } from "./agents/context.js";
import type { Chosen } from "./agents/finder.js";
import type { Wired } from "./agents/wirer.js";

export interface RunLessons {
  question: string;
  status: string;
  providerFailed?: boolean;
  chosen: Chosen[];
  wired: Wired[];
  joinSql?: string;
  repairs: string[]; // Zetaris errors the Joiner fixed
}

export async function learnFromRun(ctx: Ctx, l: RunLessons, ledgerLoaded: number): Promise<void> {
  const ok = l.status === "answered";
  const added: string[] = [];
  const conf = ok ? 0.8 : 0.5;

  for (const c of l.chosen) {
    added.push(
      remember(ctx.memory, {
        kind: "choice",
        runId: ctx.runId,
        content: `For "${c.measure}" in ${ctx.cfg.place.name}, Fieldwork chose the dataset "${c.candidate.title}" (${c.candidate.url}): ${c.reason}`,
        confidence: conf,
        refs: [c.candidate.url],
        datasetTitle: c.candidate.title,
      }).id,
    );
  }
  for (const w of l.wired) {
    added.push(
      remember(ctx.memory, {
        kind: "wiring",
        runId: ctx.runId,
        content: `Dataset "${w.title}" wires into Zetaris as ${w.shape}${w.tables.length > 1 ? ` in ${w.tables.length} pages of 2000` : ""}; filter ${w.where}; fields ${w.fields.join(", ")}; ${w.zetarisCount} of ${w.sourceCount} source records read.`,
        confidence: w.zetarisCount === w.sourceCount ? conf : 0.4,
        refs: [w.sourceUrl],
        datasetTitle: w.title,
      }).id,
    );
    if (w.excludedTestRecords > 0) {
      added.push(remember(ctx.memory, { kind: "quality", runId: ctx.runId, content: `Dataset "${w.title}" contains ${w.excludedTestRecords} test record(s); Fieldwork excludes them (filter ${w.where}).`, confidence: 0.9, datasetTitle: w.title }).id);
    }
  }
  if (ok && l.joinSql) {
    const generic = l.joinSql.replace(/r_\d{8}_[0-9a-f]{6}/g, "<run_id>").replace(/fw_[0-9a-f]{6}_/g, "fw_<run>_");
    added.push(remember(ctx.memory, { kind: "join", runId: ctx.runId, content: `A working Zetaris join for "${l.question}": ${generic.slice(0, 900)}`, confidence: 0.75 }).id);
  }
  for (const r of l.repairs) {
    added.push(remember(ctx.memory, { kind: "repair", runId: ctx.runId, content: `Zetaris rejected a Joiner query with: ${r.slice(0, 300)}. Avoid repeating it.`, confidence: 0.7 }).id);
  }

  // Memories that agents used in this run: helpful if the run was answered, not helpful only if it failed
  // for a reason the memories could be part of (a model provider failing says nothing about them).
  const used = [...new Set(ctx.recalled.map((r) => r.id))];
  const verdict = ok ? "helpful" : l.status === "failed" && !l.providerFailed ? "not_helpful" : undefined;
  if (verdict) feedback(ctx.memory, used, verdict);

  const saved = await saveMemory(ctx.db, ctx.memory, ledgerLoaded);
  await ctx.trace.log({
    agent: "memory",
    action: "remember",
    status: "ok",
    note: `H-MEM MemoryStoreService: ${added.length} new memories from this run; ${verdict ? `feedback (${verdict}) on ${used.length} recalled` : `no feedback (run ${l.status})`}; TrustLedgerService recorded ${saved.newLedger} entries; ${saved.records} memories now stored in Postgres`,
  });
}

export function datasetTag(title: string): string {
  return `dataset:${slug(title)}`;
}
