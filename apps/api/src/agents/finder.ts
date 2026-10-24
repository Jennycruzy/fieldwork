import { ChoiceSchema, type Plan } from "@fieldwork/core";
import { layerInfo, searchMontgomeryHub, searchSocrata, socrataColumns, type Candidate } from "@fieldwork/sources";
import { recall, type Recalled } from "@fieldwork/hmem";
import { SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";

export interface Chosen {
  measureId: string;
  measure: string;
  candidate: Candidate;
  reason: string;
  fields: { name: string; type: string }[];
}

// Searches the catalogs live, then lets the model choose one dataset per measure, with a reason.
export async function find(ctx: Ctx, p: Plan): Promise<Chosen[]> {
  const perMeasure: { id: string; describe: string; kind: string; candidates: Candidate[] }[] = [];
  for (const m of p.measures) {
    const seen = new Set<string>();
    const cands: Candidate[] = [];
    const terms = m.kind === "health_estimate" && p.geography === "tract" ? ["PLACES census tract", ...m.search_terms] : m.search_terms;
    for (const term of terms) {
      const found =
        m.kind === "health_estimate"
          ? await searchSocrata(p.geography === "tract" && !/census tract/i.test(term) ? `${term} census tract` : term, ["data.cdc.gov"], 6)
          : await searchMontgomeryHub(term, 6);
      for (const c of found) if (!seen.has(c.id)) (seen.add(c.id), cands.push(c));
    }
    await ctx.trace.log({ agent: "finder", action: "search", status: cands.length ? "ok" : "error", note: `${m.describe}: ${cands.length} candidates from ${m.kind === "health_estimate" ? "CDC's catalog" : "Montgomery's open data hub"} for ${m.search_terms.map((t) => `"${t}"`).join(", ")}` });
    perMeasure.push({ id: m.id, describe: m.describe, kind: m.kind, candidates: cands.slice(0, 8) });
  }

  // H-MEM: what earlier runs chose for similar measures. A confident memory whose dataset the live search
  // found again is reused without a model call; otherwise the memories go to the model as hints.
  const memories = new Map<string, Recalled[]>();
  const reused = new Map<string, { index: number; memory: Recalled }>();
  for (const m of perMeasure) {
    const got = recall(ctx.memory, `${m.describe} dataset for ${ctx.cfg.place.name}`, { kinds: ["choice", "quality"], topN: 3 });
    memories.set(m.id, got);
    ctx.recalled.push(...got);
    // Reuse needs a confident earlier choice, for a measure close enough, whose dataset the live search returned again.
    const hit = got.find((r) => r.kind === "choice" && r.confidence >= 0.75 && r.relevance >= 0.3 && m.candidates.some((c) => r.content.includes(`"${c.title}"`)));
    if (hit) reused.set(m.id, { index: m.candidates.findIndex((c) => hit.content.includes(`"${c.title}"`)), memory: hit });
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
    const fields =
      cand.kind === "arcgis_layer"
        ? (await layerInfo(cand.url)).fields.map((f) => ({ name: f.name, type: f.type.replace("esriFieldType", "").toLowerCase() }))
        : (await socrataColumns(cand.url)).map((name) => ({ name, type: "text" }));
    chosen.push({ measureId: m.id, measure: m.describe, candidate: cand, reason: c.reason, fields });
    await ctx.trace.log({ agent: "finder", action: "choose", status: "ok", note: `${m.describe} → "${cand.title}" (${fields.length} fields). ${c.reason}` });
  }
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
