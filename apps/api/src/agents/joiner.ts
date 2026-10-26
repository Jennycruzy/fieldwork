import {tractSummarySql} from "./queryTemplates.js";
import { SqlSchema, type Plan } from "@fieldwork/core";
import { checkSql, ZetarisError, type QueryResult } from "@fieldwork/zetaris";
import { recall } from "@fieldwork/hmem";
import { shared, provenance, SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
import type { Wired } from "./wirer.js";

export interface Joined {
  sql: string;
  explain?: string;
  result: QueryResult;
}

// Describes every table the Joiner may use, exactly as Zetaris will see it.
export function tableCatalog(ctx: Ctx, wired: Wired[], bridged: string[]): string[] {
  const lines = [`fw_pg.tracts(geoid STRING, name STRING, arealand_m2 BIGINT): all ${ctx.cfg.place.countyName} County census tracts`];
  for (const w of wired) {
    if(w.normalized) lines.push(`fw_pg.tract_observations(run_id STRING, source STRING, record_id STRING, geoid STRING, entity_key STRING, event_date STRING, year INT, month INT, category STRING, value DOUBLE, value_kind STRING): de-identified records from ${w.title}. ALWAYS filter run_id='${ctx.runId}' AND source='${w.label}'. event_date is the business event date; year/month are extracted from it, or source Year/Month. category comes from ${w.categoryField??"Unknown"}. value comes from ${w.valueField??"one per record"}; value_kind='${w.valueKind??"count"}'. Use SUM(value) for count-weighted summaries. For inspections value is actual inspection score (never geocoder confidence), entity_key identifies an establishment, and ROW_NUMBER() OVER (PARTITION BY entity_key ORDER BY event_date DESC, record_id) selects its latest inspection BEFORE a score threshold. For latest per-tract means, select row_number=1 AND value IS NOT NULL, then AVG(value), COUNT(*) and date coverage. For raw counts/trends use COUNT(*) for event records, SUM(value) for aggregate call summaries. Include geoid IS NOT NULL for tract analyses; citywide date/category summaries include records without coordinates.`);
    if (w.shape === "arcgis_table") lines.push(`session.${w.tables[0]} LATERAL VIEW explode(features) AS f: ${w.title}; attribute fields ${w.fields.map((f)=>`f.attributes.${f}`).join(", ")}. Nonspatial table: citywide only, no tract coordinates. Source may contain aggregate counts; never treat row counts as incident counts. Filter already applied: ${w.where}`);
    if (w.shape === "socrata_list") {
      lines.push(`session.${w.tables[0]}: ${w.title}; one row per record; columns (ALL STRINGS, CAST numbers): ${w.fields.join(", ")}; join to tracts with tractfips = geoid`);
    }
  }
  for (const label of bridged) {
    const w = wired.find((x) => x.label === label)!;
    lines.push(
      `fw_pg.tract_counts(run_id STRING, source STRING, geoid STRING, grp STRING, n INT): counts of "${w.title}" records per tract: grp = 'all' is the total per tract${w.groupField ? `; other grp values split it by ${w.groupField}` : ""}. ALWAYS filter run_id = '${ctx.runId}' AND source = '${label}'. Filter: ${w.where}`,
    );
  }
  return lines;
}

export async function join(ctx: Ctx, question: string, p: Plan, wired: Wired[], bridged: string[], revision?: string, previousSql?: string): Promise<Joined> {
  let feedback = revision ? `\nThe Evaluator sent this back: ${revision}\nPrevious SQL:\n${previousSql ?? ""}` : "";
  // Zetaris checks the SQL; if it refuses, its exact error goes back to the Joiner (up to 2 repairs).
  for (let attempt = 0; ; attempt++) {
    try {
      return await joinOnce(ctx, question, p, wired, bridged, feedback);
    } catch (e) {
      if (!(e instanceof ZetarisError) || attempt >= 2) throw e;
      await ctx.trace.log({ agent: "joiner", action: "repair", status: "info", note: `Zetaris refused the SQL; sending its error back to the Joiner: ${e.message.slice(0, 240)}`, sql: e.sql });
      feedback = `\nZetaris refused your previous SQL with this error:\n${e.message.slice(0, 600)}\nPrevious SQL:\n${e.sql}\nFix it.`;
    }
  }
}

async function joinOnce(ctx: Ctx, question: string, p: Plan, wired: Wired[], bridged: string[], feedback: string): Promise<Joined> {
  const examples = recall(ctx.memory, `working Zetaris join for: ${question}`, { kinds: ["join", "repair"], topN: 2 });
  ctx.recalled.push(...examples);
  const template=monthlySummarySql(ctx.runId,question,p,wired)??categorySummarySql(ctx.runId,p,wired)??inspectionSummarySql(ctx.runId,question,p,wired)??tractSummarySql(ctx.runId,question,p,wired,bridged);
  const { value } = template?{value:{sql:template,explain:"Compiled the plan against verified source schemas; independent checks and the Evaluator review the result."}}:await ctx.models.joiner.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Joiner. Write ONE Zetaris Lightning SQL SELECT (Spark SQL dialect) that answers the question from the tables listed.
Source filters were applied before these tables were registered; do not add state or year filters again. Only reference columns listed in the catalog. Name every output column for what it holds (request_count, violation_count), never n, cnt or c.
For time changes, group the observations by year or month; year-on-year differences use conditional aggregation and return both counts. Monthly results must be chronological; request-type summaries return counts, shares and denominators. Never count rows instead of call totals when the source rows are pre-aggregated. Zero-count pharmacy tracts require all tracts LEFT JOIN counts, not an inner join. For latest inspection queries use the observations table, not tract_counts; score rows refer to value as inspection_score (the source role is Score_1). A threshold count also returns total_inspected_establishments for each tract and sorts the below-threshold count descending.
Rules: CAST string numbers (CAST(x AS DOUBLE)); never reference the same table twice in one query (use window functions or conditional aggregation); include tract name only for tract plans; citywide month/category summaries do not group by tract; include population when a rate per resident is asked for or useful (CDC PLACES has totalpopulation for all ages and totalpop18plus for adults: divide by totalpop18plus only for a rate "per adult", and name every rate column after the population it was divided by); Retain the population source identifier as totalpopulation or totalpop18plus in result columns. Include raw counts and the denominator column whenever a rate is used so small samples can be checked. Never use aggregate FILTER syntax (Zetaris does not support it for windows); filter a CTE first or use CASE inside an aggregate. Never add a correlation unless plan.analysis.relationship is true. Return every eligible tract for relationships, with CORR(rate, prevalence) OVER () and COUNT(*) OVER () as paired_tracts after excluding missing pairs. Compute statistics BEFORE a display limit. Do not truncate correlations to 50 tracts. For rankings ORDER BY the exact measure the question ranks, and place that measure directly after the tract name before supporting columns. Keep nulls last and use tract name to break ties. Use the plan analysis basis and denominator; never correlate two raw counts. For city records, LEFT JOIN totals to all tracts and COALESCE missing counts to 0 only when source coverage is complete. Preserve NULL health values; relationship output rows must be the same non-null paired set used by CORR and paired_tracts. For tract plans retain geoid as the last column for maps. Return up to 200 rows; no semicolons.
Shape: {"sql": "...", "explain": "one sentence: what the query does"}`,
      },
      {
        role: "user",
        content:
          shared(ctx) + `Question: ${question}\n` +
          dataBlock("plan", p) +
          "\n" +
          dataBlock("tables", tableCatalog(ctx, wired, bridged).join("\n")) +
          (examples.length ? "\n" + dataBlock("memory_from_earlier_runs (adapt table names and run_id; never copy them)", examples.map((e) => e.content)) : "") +
          feedback,
      },
    ],
    SqlSchema,
    p.analysis?.relationship?8000:4000,
  );
  const drafted = monthlySummarySql(ctx.runId, question, p, wired) ?? categorySummarySql(ctx.runId,p,wired) ?? inspectionSummarySql(ctx.runId,question,p,wired) ?? value.sql.trim().replace(/;\s*$/, "");
  const sql = fullRunId(drafted, ctx.runId);
  if (sql !== drafted) await ctx.trace.log({ agent: "joiner", action: "run_id", status: "info", note: `The query named this run by a shortened id; corrected to '${ctx.runId}'.` });
  const chk = checkSql(sql, "reader");
  if (!chk.ok) throw new Error(`refused the Joiner's SQL: ${chk.reason}`);
  const result = await ctx.zetaris.query(sql, p.geography==="city"?1000:200);
  await ctx.trace.log({ agent: "joiner", action: "query", status: "ok", note: value.explain ?? "ran the analysis query", sql, zetarisMs: result.ms, rows: result.rows.length });
  if(ctx.world) {
    const source=provenance(ctx,"joiner");
    const finding=await ctx.world.upsertEntity({type:"finding",externalKey:{system:ctx.runId,id:"query"},attrs:{sql,headers:result.headers,rows:result.rows.length},source});
    for(const s of ctx.world.entities().filter((e)=>e.type==="source")) await ctx.world.relate({from:finding.id,type:"joins to",to:s.id,context:s.id,source});
  }
  return { sql, explain: value.explain, result };
}

export function monthlySummarySql(runId:string,question:string,p:Plan,wired:Wired[]):string|undefined {
 if(p.geography!=="city"||p.output!=="trend"||!/\bmonth/i.test(question)||wired.length!==1||!wired[0]?.normalized||wired[0].valueKind!=="count")return;
 const w=wired[0];
 const countLabel=/^Call_Count_By_Origin$/i.test(w.valueField??"")?"call_activity_count":"record_count";
 const from=p.years?.from,to=p.years?.to;
 const years=[from?`year >= ${from}`:undefined,to?`year <= ${to}`:undefined].filter(Boolean);
 return `SELECT year, month, SUM(value) AS ${countLabel} FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='${w.label}' AND month IS NOT NULL${years.length?" AND "+years.join(" AND "):""} GROUP BY year, month ORDER BY year, month`;
}

export function categorySummarySql(runId:string,p:Plan,wired:Wired[]):string|undefined {
 if(p.geography!=="city"||p.output==="trend"||wired.length!==1||!wired[0]?.normalized||!wired[0].groupField||wired[0].valueKind!=="count")return;
 const w=wired[0];
 return `SELECT category, SUM(value) AS record_count, SUM(SUM(value)) OVER () AS total_records, 100.0*SUM(value)/SUM(SUM(value)) OVER () AS share_pct FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='${w.label}' GROUP BY category ORDER BY record_count DESC, category`;
}

export function inspectionSummarySql(runId:string,question:string,p:Plan,wired:Wired[]):string|undefined {
 if(p.geography!=="tract"||wired.length!==1||!wired[0]?.normalized||wired[0].valueKind!=="score"||!/\blatest\b/i.test(question))return;
 const w=wired[0],threshold=question.match(/\b(?:below|less than|under)\s+(\d+(?:\.\d+)?)/i)?.[1];
 const cte=`WITH ranked AS (SELECT geoid, entity_key, value AS inspection_score, ROW_NUMBER() OVER (PARTITION BY entity_key ORDER BY event_date DESC NULLS LAST, record_id DESC) AS rn FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='${w.label}'), latest AS (SELECT geoid, entity_key, inspection_score FROM ranked WHERE rn=1 AND inspection_score IS NOT NULL) `;
 if(threshold)return cte+`SELECT t.name, SUM(CASE WHEN l.inspection_score < ${Number(threshold)} THEN 1 ELSE 0 END) AS below_threshold_count, COUNT(l.entity_key) AS total_inspected_establishments, t.geoid FROM fw_pg.tracts t LEFT JOIN latest l ON t.geoid=l.geoid GROUP BY t.name,t.geoid ORDER BY below_threshold_count DESC,t.name`;
 if(/\b(average|mean)\b/i.test(question))return cte+"SELECT t.name, AVG(l.inspection_score) AS average_latest_inspection_score, COUNT(*) AS establishment_count, t.geoid FROM latest l JOIN fw_pg.tracts t ON t.geoid=l.geoid GROUP BY t.name,t.geoid ORDER BY average_latest_inspection_score ASC,t.name";
}

// The model sometimes writes this run's id in its short form (r_28edaa for r_20261025_28edaa, 25 Oct Q10),
// which matches nothing. Only the short form of this run's own id is corrected.
export function fullRunId(sql: string, runId: string): string {
  const short = `r_${runId.split("_").pop()}`;
  return short === runId ? sql : sql.replace(new RegExp(`'${short}'`, "g"), `'${runId}'`);
}
