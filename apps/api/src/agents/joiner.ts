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
  const { value } = await ctx.models.joiner.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Joiner. Write ONE Zetaris Lightning SQL SELECT (Spark SQL dialect) that answers the question from the tables listed.
Source filters were applied before these tables were registered; do not add state or year filters again. Only reference columns listed in the catalog.
Rules: CAST string numbers (CAST(x AS DOUBLE)); never reference the same table twice in one query (use window functions or conditional aggregation); include the tract name; include population when a rate per resident is asked for or useful (CDC PLACES has totalpopulation for all ages and totalpop18plus for adults: divide by totalpop18plus only for a rate "per adult", and name every rate column after the population it was divided by); Include raw counts and the denominator column whenever a rate is used so small samples can be checked. Never use aggregate FILTER syntax (Zetaris does not support it for windows); filter a CTE first or use CASE inside an aggregate. Never add a correlation unless plan.analysis.relationship is true. Return every eligible tract for relationships, with CORR(rate, prevalence) OVER () and COUNT(*) OVER () as paired_tracts after excluding missing pairs. Compute statistics BEFORE a display limit. Do not truncate correlations to 50 tracts. For rankings ORDER BY the exact measure the question ranks, and place that measure directly after the tract name before supporting columns. Keep nulls last and use tract name to break ties. Use the plan analysis basis and denominator; never correlate two raw counts. For city records, LEFT JOIN totals to all tracts and COALESCE missing counts to 0 only when source coverage is complete. Preserve NULL health values. Always retain geoid as the last column for maps. Return up to 200 rows; no semicolons.
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
    8000,
  );
  const sql = value.sql.trim().replace(/;\s*$/, "");
  const chk = checkSql(sql, "reader");
  if (!chk.ok) throw new Error(`refused the Joiner's SQL: ${chk.reason}`);
  const result = await ctx.zetaris.query(sql, 200);
  await ctx.trace.log({ agent: "joiner", action: "query", status: "ok", note: value.explain ?? "ran the analysis query", sql, zetarisMs: result.ms, rows: result.rows.length });
  if(ctx.world) {
    const source=provenance(ctx,"joiner");
    const finding=await ctx.world.upsertEntity({type:"finding",externalKey:{system:ctx.runId,id:"query"},attrs:{sql,headers:result.headers,rows:result.rows.length},source});
    for(const s of ctx.world.entities().filter((e)=>e.type==="source")) await ctx.world.relate({from:finding.id,type:"joins to",to:s.id,context:s.id,source});
  }
  return { sql, explain: value.explain, result };
}
