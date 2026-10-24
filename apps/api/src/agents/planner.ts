import { PlanSchema, type Plan } from "@fieldwork/core";
import { shared, provenance, SYSTEM_BASE, type Ctx } from "./context.js";

const SHAPE = `{
 "in_scope": boolean,
 "out_of_scope_reason": string | null,
 "geography": "tract" | "council_district" | "city",
 "years": {"from": number | null, "to": number | null} | null,
 "measures": [{"id": "m1", "describe": "what to measure, in plain words", "kind": "health_estimate" | "city_records" | "environmental_records", "search_terms": ["2-4 short catalog search phrases"]}],
 "analysis": {"basis": "counts" | "rates" | "mixed", "denominator": "none" | "residents" | "adults", "relationship": boolean, "reason": "why these units answer this question", "rank_measure": "measure and direction for sorting"},
 "output": "ranking" | "comparison" | "trend" | "list"
}`;

export async function plan(ctx: Ctx, question: string, revision?: string): Promise<Plan> {
  const messages = [
    {
      role: "system" as const,
      content: `${SYSTEM_BASE}
You are the Planner. Turn the user's question into a data plan.
What data exists for ${ctx.cfg.place.name}:
- city_records: the City of Montgomery's open data hub (records such as code violations, service requests, calls, inspections, permits, facilities), as map points with dates and types.
- environmental_records: EPA ECHO regulated facility registry, scoped to Montgomery County; listings are not emissions or exposure measurements.
- health_estimate: CDC PLACES estimates for adults by census tract (e.g. asthma, diabetes, housing insecurity, food insecurity, lack of transportation, depression), with tract population.
Use "tract" geography when city records must be compared with health estimates (city records are placed into census tracts by location).
A question is out of scope if it is about another place, a person, a prediction, or needs data not listed above.
A ranking with a supporting measure is NOT a relationship question: do not add a correlation unless the question asks about association, correlation, or whether more X accompanies more Y. Set relationship false for ordinary rankings.
Choose counts versus rates deliberately and explain the choice in analysis.reason. Raw counts answer workload questions. Cross-tract associations or correlations MUST use population-adjusted rates, comparing city records per 1,000 residents with CDC adult prevalence percentages. Use totalpopulation for residents, totalpop18plus ONLY for per-adult rates. Do not estimate adult case counts from all-age population. Include a CDC population measure when a city rate needs a denominator. Set relationship true for association/correlation questions, even if the question says "more X also more Y". rank_measure states the requested sorting measure, not a supporting count.
Today is ${ctx.today.toISOString().slice(0, 10)}. Use 1-3 measures. Search terms must be short (1-3 words) catalog keywords.
Shape: ${SHAPE}`,
    },
    { role: "user" as const, content: shared(ctx) + (revision ? `Question: ${question}\nThe Evaluator asked for a new plan: ${revision}` : `Question: ${question}`) },
  ];
  const { value } = await ctx.models.planner.json(messages, PlanSchema, 3000);
  if(value.analysis) {
    const asksRelationship=/\b(correlat\w*|associat\w*|relationship|related|connection)\b|\b(do|does|are)\b[\s\S]*\balso\b|\b(more|higher|lower)\b[\s\S]*\b(more|higher|lower)\b/i.test(question);
    value.analysis.relationship=asksRelationship || (value.output!=="ranking" && value.analysis.relationship);
    if(!asksRelationship && value.measures.some((m)=>m.kind==="health_estimate") && value.measures.some((m)=>m.kind==="city_records") && !/\bper\b/i.test(question)) {
      value.analysis.basis="mixed";value.analysis.denominator="adults";
      value.analysis.reason += " CDC prevalence is an adult rate; the accompanying city count is raw workload, not a second health rate.";
    }
    if(!asksRelationship && value.analysis.basis === "rates" && value.analysis.denominator === "none") {
      value.analysis.denominator=value.measures.some((m)=>m.kind === "health_estimate") ? "adults" : "residents";
      value.analysis.reason += " The rate denominator is explicit: CDC prevalence describes adults; any accompanying raw city count remains a workload count.";
    }
    if(asksRelationship && value.analysis.basis!=="rates") {
      value.analysis.basis="rates";value.analysis.denominator="residents";
      value.analysis.reason="Compare population-adjusted rates across neighborhoods with different population sizes.";
    }
  }
  if (ctx.world) {
    for (const m of value.measures) await ctx.world.upsertEntity({type:"measure",externalKey:{system:ctx.runId,id:m.id},attrs:{...m,analysis:value.analysis},source:provenance(ctx,"planner")});
    for (const c of ctx.world.entities().filter((e)=>e.type==="challenge"&&e.attrs.status==="open")) await ctx.world.upsertEntity({type:"challenge",externalKey:{system:ctx.runId,id:String(c.attrs.round)},attrs:{status:"resolved",resolution:value.analysis?.reason ?? revision},source:provenance(ctx,"planner")});
  }
  return value;
}
