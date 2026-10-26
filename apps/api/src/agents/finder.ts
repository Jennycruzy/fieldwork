import { ChoiceSchema, FieldworkError, type Plan } from "@fieldwork/core";
import { getJson, layerInfo, resolveLayerUrl, searchEpa, searchMontgomeryHub, searchSocrata, socrataColumns, type Candidate } from "@fieldwork/sources";
import { recall, type Recalled } from "@fieldwork/hmem";
import { SYSTEM_BASE, provenance, dataBlock, type Ctx } from "./context.js";

export interface Chosen {
  measureId: string;
  measure: string;
  candidate: Candidate;
  reason: string;
  geometryType?: string;
  maxRecordCount?: number;
  fields: { name: string; type: string; alias?: string }[];
}

// Searches the catalogs live, then lets the model choose one dataset per measure, with a reason.
export async function find(ctx: Ctx, p: Plan): Promise<Chosen[]> {
  const perMeasure: { id: string; describe: string; kind: string; candidates: Candidate[] }[] = [];
  const discovered=await Promise.all(p.measures.map(async(m)=>{
    const seen = new Set<string>();
    const cands: Candidate[] = [];
    const searched:string[]=[];
    const cached=rememberedCandidate(ctx,m);
    if(cached){
      cands.push(cached);seen.add(cached.id);
      await ctx.trace.log({agent:"finder",action:"source_memory",status:"ok",note:"Reusing recently verified catalogue metadata for "+cached.title+"; schema and source counts are still checked live."});
    }
    const terms = m.kind === "health_estimate" && p.geography === "tract" ? ["PLACES census tract", ...m.search_terms] : m.kind === "environmental_records" ? m.search_terms.slice(0,1) : m.search_terms;
    for (const term of cached?[]:terms) {
      searched.push(term);
      const found =
        m.kind === "health_estimate"
          ? await searchSocrata(p.geography === "tract" && !/census tract/i.test(term) ? `${term} census tract` : term, ["data.cdc.gov"], 6)
          : m.kind === "environmental_records" ? await searchEpa(ctx.cfg.place.stateAbbr,ctx.cfg.place.countyName) : await searchMontgomeryHub(term, 6);
      for (const c of found) if (!seen.has(c.id)) (seen.add(c.id), cands.push(c));
    }
    if(cands.length===0&&m.kind!=="environmental_records") {
      // Long natural-language phrases can be too restrictive for catalog search.
      // Broaden from the request's own words, without an inventory of known sources.
      const tokens=[...new Set(terms.flatMap(term=>term.toLowerCase().match(/[a-z]{4,}/g)??[]))].slice(0,6);
      for(const token of tokens) {
        if(searched.includes(token))continue;
        searched.push(token);
        const found=m.kind==="health_estimate"?await searchSocrata(p.geography==="tract"?`${token} census tract`:token,["data.cdc.gov"],6):await searchMontgomeryHub(token,6);
        for(const c of found)if(!seen.has(c.id)){seen.add(c.id);cands.push(c);}
        await ctx.trace.log({agent:"finder",action:"broaden_search",status:found.length?"ok":"info",note:`Broadened catalog search to "${token}": ${found.length} candidates.`});
      }
    }
    await ctx.trace.log({ agent: "finder", action: "search", status: cands.length ? "ok" : "error", note: `${m.describe}: ${cands.length} candidates from ${m.kind === "health_estimate" ? "CDC's catalog" : "Montgomery's open data hub"} for ${searched.map((t) => `"${t}"`).join(", ")}` });
    return { id: m.id, describe: m.describe, kind: m.kind, candidates: cands.slice(0, 8) };
  }));
  perMeasure.push(...discovered);

  const absent = perMeasure.find((m) => m.candidates.length === 0);
  if (absent) throw new FieldworkError("NO_SOURCE", absent.describe);

  // H-MEM: what earlier runs chose for similar measures. A confident memory whose dataset the live search
  // found again is reused without a model call; otherwise the memories go to the model as hints.
  const memories = new Map<string, Recalled[]>();
  const reused = new Map<string, { index: number; memory: Recalled }>();
  for (const m of perMeasure) {
    const got = recall(ctx.memory, `${m.describe} dataset for ${ctx.cfg.place.name}`, { kinds: ["choice", "quality"], topN: 3 });
    memories.set(m.id, got);
    ctx.recalled.push(...got);
    // Reuse needs a confident earlier choice, for a measure close enough, whose dataset the live search returned again.
    const measureEntity=ctx.world?.entities().find(e=>e.type==="measure"&&e.id===`measure:${ctx.runId}:${m.id}`);
    const worldCandidate=measureEntity?ctx.world?.view("sources").neighborsOf(measureEntity.id,{via:"selected"}).find(e=>e.attrs.measure===m.describe&&m.candidates.some(c=>c.url===e.attrs.url)):undefined;
    if(worldCandidate) {
      const index=m.candidates.findIndex(c=>c.url===worldCandidate.attrs.url);
      reused.set(m.id,{index,memory:{id:worldCandidate.id,content:`"${m.candidates[index]!.title}"`,kind:"choice",confidence:1,relevance:1,source:"current run World Model"}});
    }
    const hit = got.find((r) => r.kind === "choice" && r.confidence >= 0.75 && r.relevance >= 0.3 && m.candidates.some((c) => r.content.includes(`"${c.title}"`)));
    if (hit&&!worldCandidate) reused.set(m.id, { index: m.candidates.findIndex((c) => hit.content.includes(`"${c.title}"`)), memory: hit });
    await ctx.trace.log({
      agent: "memory",
      action: "recall",
      status: "info",
      note: got.length
        ? `H-MEM MemoryRetrievalService: ${got.length} memories for "${m.describe}" (${got.map((g) => `${g.id} ${g.kind} relevance ${g.relevance} conf ${g.confidence}`).join(", ")})${hit ? `; reusing the earlier choice from ${hit.source}, no model call needed` : ""}`
        : `H-MEM MemoryRetrievalService: nothing remembered yet for "${m.describe}"`,
    });
  }

  const listing = perMeasure.map((m) => ({
    measure_id: m.id,
    measure: m.describe,
    candidates: m.candidates.map((c, i) => ({ index: i, title: c.title, description: c.description.slice(0, 220), updated: c.modified?.slice(0, 10), release_year: releaseYear(c.title), newest_in_series: isNewestInSeries(c, m.candidates) })),
  }));
  const needModel = perMeasure.filter((m) => !reused.has(m.id));
  const fromModel = needModel.length === 0 ? { choices: [] } : (await ctx.models.finder.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Finder. For each measure pick the one candidate dataset that best measures it for ${ctx.cfg.place.name}${p.geography === "tract" ? " at census-tract level (prefer the newest CDC PLACES census tract release for health measures)" : ""}.
Prefer current, official, record-level or tract-level data. When several releases of the same series exist, choose the one marked newest_in_series unless it lacks the measure. Shape: {"choices": [{"measure_id": "m1", "candidate_index": 0, "reason": "one sentence"}]}`,
      },
      {
        role: "user",
        content:
          dataBlock("candidates", listing.filter((l) => needModel.some((m) => m.id === l.measure_id))) +
          "\n" +
          dataBlock("memory_from_earlier_runs", needModel.flatMap((m) => (memories.get(m.id) ?? []).map((r) => r.content))),
      },
    ],
    ChoiceSchema,
    4000,
  )).value;
  const value = {
    choices: [
      ...[...reused].map(([measure_id, r]) => ({ measure_id, candidate_index: r.index, reason: `Same dataset an earlier run chose and checked (memory ${r.memory.id}, confidence ${r.memory.confidence}).` })),
      ...fromModel.choices,
    ],
  };

  const chosen: Chosen[] = [];
  for (const c of value.choices) {
    const m = perMeasure.find((x) => x.id === c.measure_id);
    const cand = m?.candidates[c.candidate_index];
    if (!m || !cand) continue;
    if (cand.kind === "arcgis_layer") cand.url = await resolveLayerUrl(cand.url);
    const info = cand.kind === "arcgis_layer" ? await layerInfo(cand.url) : undefined;
    const fields =
      cand.kind === "arcgis_layer"
        ? info!.fields.map((f) => ({ name: f.name, alias:f.alias, type: f.type.replace("esriFieldType", "").toLowerCase() }))
        : cand.kind === "epa_facilities" ? (cand.fields ?? []).map((name)=>({name,type:"text"})) : (await socrataColumns(cand.url)).map((name) => ({ name, type: "text" }));
    if(cand.kind === "socrata_resource") {
      const metadataUrl=cand.url.replace("/resource/","/api/views/");
      const metadata=await getJson(metadataUrl) as {license?:{name?:string};licenseId?:string};
      cand.licence=metadata.license?.name ?? metadata.licenseId ?? "No license statement supplied in metadata";cand.licenceUrl=metadataUrl;
    }
    chosen.push({ measureId: m.id, measure: m.describe, candidate: cand, reason: c.reason, fields, geometryType:info?.geometryType, maxRecordCount:info?.maxRecordCount });
    if(ctx.world) {
      const source=provenance(ctx,"finder");
      const entity=await ctx.world.upsertEntity({type:"candidate",externalKey:{system:ctx.runId,id:`${m.id}:${cand.kind==="epa_facilities"?cand.title:cand.id}`},attrs:{measure:m.describe,title:cand.title,url:cand.url,fields,geometryType:info?.geometryType??null,selected:true},source});
      const measure=ctx.world.entities().find(e=>e.id===`measure:${ctx.runId}:${m.id}`);
      if(measure)await ctx.world.relate({from:measure.id,type:"selected",to:entity.id,source});
    }
    await ctx.trace.log({ agent: "finder", action: "choose", status: "ok", note: `${m.describe} → "${cand.title}" (${fields.length} fields). ${c.reason}` });
  }
  if (chosen.length !== p.measures.length) throw new FieldworkError("NO_SOURCE", "all of the requested measures. Review the discovered candidates in the trace.");
  return chosen;
}

// "PLACES: Census Tract Data ..., 2025 release" -> 2025
export function releaseYear(title: string): number | undefined {
  const m = title.match(/\b(19|20)\d{2}\b(?=[^\d]*$)/);
  return m ? Number(m[0]) : undefined;
}

// Same title apart from the year = same series; true for the highest year in that series.
export function isNewestInSeries(c: Candidate, all: Candidate[]): boolean {
  const key = (t: string) => t.replace(/\b(19|20)\d{2}\b/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const y = releaseYear(c.title);
  if (y === undefined) return true;
  return all.filter((o) => key(o.title) === key(c.title)).every((o) => (releaseYear(o.title) ?? 0) <= y);
}

export function rememberedCandidate(ctx:Ctx,m:Plan["measures"][number]):Candidate|undefined{
 const key=(s:string)=>s.toLowerCase().replace(/\s+/g," ").trim();
 for(const record of ctx.memory.store.all()){
  if(record.confidence<.75||record.supersededBy||!record.tags.includes("fw:choice"))continue;
  try{
   const data=JSON.parse(record.content) as {catalog_source?:{candidate:Candidate;kind:string;terms:string[];place:string;observed_at:string}};
   const c=data.catalog_source;
   if(!c||c.kind!==m.kind||c.place!==ctx.cfg.place.name)continue;
   const age=ctx.today.getTime()-Date.parse(c.observed_at);
   if(!Number.isFinite(age)||age<0||age>86400000)continue;
   if(!m.search_terms.some(t=>c.terms.some(old=>key(t)===key(old))))continue;
   if(c.candidate.kind==="socrata_resource"&&!c.candidate.title.includes(String(ctx.today.getUTCFullYear()))&&ctx.today.getUTCMonth()===0)continue;
   ctx.recalled.push({id:record.id,content:record.content,confidence:record.confidence,relevance:1,kind:"choice",source:record.source});
   return structuredClone(c.candidate);
  }catch{/* Earlier prose memories cannot replace catalogue metadata. */}
 }
 return;
}
