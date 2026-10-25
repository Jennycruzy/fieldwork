// What a run teaches Fieldwork, written to H-MEM at the end of the run.

import { feedback, remember as addFact, saveMemory, slug, embed, type HMEM, type SourceFact } from "@fieldwork/hmem";
import {syncWorld} from "./worldMemory.js";
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
  const remember=(memory:HMEM,f:SourceFact)=>addFact(memory,{...f,key:JSON.stringify([l.question.toLowerCase().replace(/\s+/g," ").trim(),f.kind,f.content.replace(/r_\d{8}_[0-9a-f]{6}/g,"<run>").replace(/fw_[0-9a-f]{6}_/g,"fw_<run>_")])});
  const ok = l.status === "answered";
  const added: string[] = [];
  const conf = ok ? 0.8 : 0.5;

  for (const c of l.chosen) {
    const verified=l.wired.find(w=>w.measureId===c.measureId&&w.zetarisCount>0);
    if(!verified) {
      // Catalog metadata is observed; a selection rationale is still a hypothesis.
      if(c.candidate.kind==="arcgis_layer"&&!c.geometryType) {
        const content=`Dataset "${c.candidate.title}" publishes a nonspatial table with no tract locations; it was not successfully wired for this request.`;
        for(const previous of ctx.memory.store.all().filter(m=>m.tags.includes(datasetTag(c.candidate.title))&&m.tags.includes("fw:choice")&&/tract.level counts|directly provides.*tract/i.test(m.content))) {
          ctx.memory.store.update(previous.id,{content,embedding:embed(content),tags:previous.tags.filter(t=>t!=="fw:choice").concat("fw:quality"),confidence:.9});
        }
        added.push(remember(ctx.memory,{kind:"quality",runId:ctx.runId,content,confidence:.9,refs:[c.candidate.url],datasetTitle:c.candidate.title}).id);
      }
      continue;
    }
    added.push(remember(ctx.memory,{
      kind:"choice",runId:ctx.runId,
      content:`For "${c.measure}" in ${ctx.cfg.place.name}, dataset "${c.candidate.title}" (${c.candidate.url}) was read through Zetaris: ${verified.zetarisCount} records; fields ${verified.fields.join(", ")}. Catalog selection reasons are hypotheses, not verified capabilities.`,
      confidence:conf,refs:[c.candidate.url],datasetTitle:c.candidate.title,
    }).id);
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

  if(ctx.world) {
    const synced=syncWorld(ctx.memory,ctx.world,l.question,ctx.runId,l.status);
    added.push(...synced);
    await ctx.trace.log({agent:"memory",action:"world_sync",status:"ok",note:`World Model synchronized ${synced.length} complete entity memories with stable keys and relationship provenance.`});
  }
  // Memories that agents used in this run: helpful if the run was answered, not helpful only if it failed
  // for a reason the memories could be part of (a model provider failing says nothing about them).
  const used = [...new Set(ctx.recalled.map((r) => r.id))];
  const verdict = ok ? "helpful" : l.status === "failed" && !l.providerFailed ? "not_helpful" : undefined;
  if (verdict) feedback(ctx.memory, used, verdict);

  ctx.writtenMemories = added.map((id)=>ctx.memory.store.get(id)).filter((m)=>m!==undefined).map((m)=>({id:m!.id,content:m!.content}));
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
