import { PlanSchema, type Plan } from "@fieldwork/core";
import { shared, provenance, SYSTEM_BASE, type Ctx } from "./context.js";

const SHAPE = `{
 "in_scope": boolean,
 "scope_limit": "place" | "personal" | "non_public" | null,
 "out_of_scope_reason": string | null,
 "geography": "tract" | "council_district" | "city",
 "years": {"from": number | null, "to": number | null} | null,
 "measures": [{"id": "m1", "describe": "what to measure, in plain words", "kind": "health_estimate" | "city_records" | "environmental_records", "search_terms": ["2-4 short catalog search phrases"]}],
 "analysis": {"basis": "counts" | "rates" | "mixed" | "scores", "denominator": "none" | "residents" | "adults", "relationship": boolean, "reason": "why these units answer this question", "rank_measure": "measure and direction for sorting"},
 "output": "ranking" | "comparison" | "trend" | "list"
}`;

export async function plan(ctx: Ctx, question: string, revision?: string): Promise<Plan> {
  const messages = [
    {
      role: "system" as const,
      content: `${SYSTEM_BASE}
You are the Planner. Turn the user's question into a data plan.
Catalogs to search for ${ctx.cfg.place.name}:
- city_records: the City of Montgomery's open data hub (records such as code violations, service requests, calls, inspections, permits, facilities), as map points with dates and types.
- environmental_records: EPA ECHO regulated facility registry, scoped to Montgomery County; listings are not emissions or exposure measurements.
- health_estimate: CDC PLACES estimates for adults by census tract (e.g. asthma, diabetes, housing insecurity, food insecurity, lack of transportation, depression), with tract population.
Use one measure per data series, not separate measures for individual years or months. Time comparisons use years and group the source observations by year/month.
Use "tract" geography when city records must be compared with health estimates (city records are placed into census tracts by location).
Refuse ONLY for another place (scope_limit place), a personal request such as diagnosis or forecasting (personal), or non-public individual records (non_public). Set scope_limit null for in-scope public-data questions. These catalogs are search starting points, not a complete inventory. Availability is the Finder's decision after a live search: never refuse because a dataset is unknown, unavailable, not listed here, or absent from memory. Build search measures for public facilities and services even if their catalog is unfamiliar.
A ranking with a supporting measure is NOT a relationship question: do not add a correlation unless the question asks about association, correlation, or whether more X accompanies more Y. Set relationship false for ordinary rankings.
Choose counts versus rates deliberately and explain the choice in analysis.reason. Raw counts answer workload questions. Cross-tract associations or correlations MUST use population-adjusted rates, comparing city records per 1,000 residents with CDC adult prevalence percentages. Use totalpopulation for residents, totalpop18plus ONLY for per-adult rates. Do not estimate adult case counts from all-age population. Include a CDC population measure when a city rate needs a denominator. Set relationship true for association/correlation questions, even if the question says "more X also more Y". rank_measure states the requested sorting measure, not a supporting count.
Today is ${ctx.today.toISOString().slice(0, 10)}. Use 1-3 measures. Search terms must be short (1-3 words) catalog keywords.
Shape: ${SHAPE}`,
    },
    {
      role: "user" as const,
      content:
        shared(ctx) +
        (revision
          ? `Question: ${question}\nThe Evaluator asked for a new plan: ${revision}`
          : `Question: ${question}`),
    },
  ];
  let { value } = await ctx.models.planner.json(messages, PlanSchema, 3000);
  if (!value.in_scope && !value.scope_limit) {
    const retry = await ctx.models.planner.json(
      [
        ...messages,
        {
          role: "user" as const,
          content:
            "Availability is not a scope limit. Return an in-scope search plan for this public-data question; the Finder must search before reporting a missing source. Refusal requires scope_limit place, personal, or non_public.",
        },
      ],
      PlanSchema,
      3000,
    );
    value = retry.value;
    if (!value.in_scope && !value.scope_limit) {
      value.in_scope = true;
      value.out_of_scope_reason = null;
      if (!value.measures.length) {
        const terms = question
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter(
            (w) =>
              w.length > 3 &&
              !/^(which|what|have|with|most|Montgomery|census|tracts|listed|residents)$/i.test(w),
          )
          .slice(0, 3);
        value.measures = [
          {
            id: "m1",
            describe: question,
            kind: "city_records",
            search_terms: terms.length ? terms : ["public data"],
          },
        ];
      }
    }
  }
  if (value.analysis) {
    if (/\b(average|mean)\b.*\bscore/i.test(question)) {
      value.analysis.basis = "scores";
      value.analysis.denominator = "none";
      value.analysis.reason +=
        " Inspection scores are measured in source score points; establishment counts describe sample size, not population rates.";
    }
    const asksRelationship =
      /\b(correlat\w*|associat\w*|relationship|related|connection)\b|\b(do|does|are)\b[\s\S]*\balso\b|\b(more|higher|lower)\b[\s\S]*\b(more|higher|lower)\b/i.test(
        question,
      );
    value.analysis.relationship = asksRelationship;
    // An unadjusted year-to-year workload change is a difference of counts.
    // Population series suggested by the model are not a request for rate adjustment.
    const timeChange =
      value.years?.from != null &&
      value.years.to != null &&
      value.years.from !== value.years.to &&
      /increas|decreas|change|difference/i.test(value.analysis.rank_measure);
    const requestedAdjustment =
      /\b(per|rates?|residents?|adults?|population|prevalence|percent(?:age)?|normali[sz]ed|adjusted)\b/i.test(
        question,
      );
    const citySeries = value.measures.filter((m) => m.kind === "city_records");
    const ancillary = value.measures.filter((m) => m.kind !== "city_records");
    const onlyPopulation = ancillary.every(
      (m) =>
        m.kind === "health_estimate" &&
        /\bpopulation\b/i.test(m.describe) &&
        !/prevalence|asthma|diabet|blood pressure|health outcome/i.test(m.describe),
    );
    if (
      !asksRelationship &&
      timeChange &&
      !requestedAdjustment &&
      value.analysis.basis !== "scores" &&
      citySeries.length === 1 &&
      onlyPopulation
    ) {
      value.measures = citySeries;
      value.analysis.basis = "counts";
      value.analysis.denominator = "none";
      value.analysis.rank_measure =
        "count change " + (/decreas|declin|fall|drop/i.test(question) ? "ascending" : "descending");
      value.analysis.reason =
        "Compare the recorded count in each requested year and rank their arithmetic difference; no population adjustment was requested.";
    }

    if (
      !asksRelationship &&
      value.measures.some((m) => m.kind === "health_estimate") &&
      value.measures.some((m) => m.kind === "city_records") &&
      !/\bper\b/i.test(question)
    ) {
      value.analysis.basis = "mixed";
      value.analysis.denominator = "adults";
      value.analysis.reason +=
        " CDC prevalence is an adult rate; the accompanying city count is raw workload, not a second health rate.";
    }
    if (!asksRelationship && value.analysis.basis === "rates" && value.analysis.denominator === "none") {
      value.analysis.denominator = value.measures.some((m) => m.kind === "health_estimate")
        ? "adults"
        : "residents";
      value.analysis.reason +=
        " The rate denominator is explicit: CDC prevalence describes adults; any accompanying raw city count remains a workload count.";
    }
    if (asksRelationship && value.analysis.basis !== "rates") {
      value.analysis.basis = "rates";
      value.analysis.denominator = "residents";
      value.analysis.reason =
        "Compare population-adjusted rates across neighborhoods with different population sizes.";
    }
  }
  if (
    value.in_scope &&
    value.analysis?.denominator === "residents" &&
    value.analysis.basis === "rates" &&
    !value.measures.some((m) => m.kind === "health_estimate")
  ) {
    value.measures.push({
      id: "population",
      describe: "Total resident population by census tract for the requested rates",
      kind: "health_estimate",
      search_terms: ["PLACES census tract"],
    });
  }
  if (ctx.world) {
    for (const m of value.measures)
      await ctx.world.upsertEntity({
        type: "measure",
        externalKey: { system: ctx.runId, id: m.id },
        attrs: { ...m, analysis: value.analysis },
        source: provenance(ctx, "planner"),
      });
    for (const c of ctx.world.entities().filter((e) => e.type === "challenge" && e.attrs.status === "open"))
      await ctx.world.upsertEntity({
        type: "challenge",
        externalKey: { system: ctx.runId, id: String(c.attrs.round) },
        attrs: { status: "resolved", resolution: value.analysis?.reason ?? revision },
        source: provenance(ctx, "planner"),
      });
  }
  return value;
}
