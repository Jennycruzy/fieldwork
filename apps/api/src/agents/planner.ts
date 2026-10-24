import { PlanSchema, type Plan } from "@fieldwork/core";
import { SYSTEM_BASE, type Ctx } from "./context.js";

const SHAPE = `{
 "in_scope": boolean,
 "out_of_scope_reason": string | null,
 "geography": "tract" | "council_district" | "city",
 "years": {"from": number | null, "to": number | null} | null,
 "measures": [{"id": "m1", "describe": "what to measure, in plain words", "kind": "health_estimate" | "city_records", "search_terms": ["2-4 short catalog search phrases"]}],
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
- health_estimate: CDC PLACES estimates for adults by census tract (e.g. asthma, diabetes, housing insecurity, food insecurity, lack of transportation, depression), with tract population.
Use "tract" geography when city records must be compared with health estimates (city records are placed into census tracts by location).
A question is out of scope if it is about another place, a person, a prediction, or needs data not listed above.
Today is ${ctx.today.toISOString().slice(0, 10)}. Use 1-3 measures. Search terms must be short (1-3 words) catalog keywords.
Shape: ${SHAPE}`,
    },
    { role: "user" as const, content: revision ? `Question: ${question}\nThe Evaluator asked for a new plan: ${revision}` : `Question: ${question}` },
  ];
  const { value } = await ctx.models.planner.json(messages, PlanSchema, 3000);
  return value;
}
