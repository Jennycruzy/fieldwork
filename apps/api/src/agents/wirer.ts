import { WiringSchema, looksLikeTestValue, type Plan } from "@fieldwork/core";
import { checkSql, createSessionTable, tableName, testRequest, ZetarisError, type Shape } from "@fieldwork/zetaris";
import { featurePageUrl, getJson, layerCount, normaliseLayerUrl, socrataCount, soqlUrl, statsUrl } from "@fieldwork/sources";
import { recall } from "@fieldwork/hmem";
import { SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
import type { Chosen } from "./finder.js";

export interface Wired {
  measureId: string;
  measure: string;
  label: string;
  title: string;
  shape: Shape;
  tables: string[]; // one per page for paged sources
  fields: string[];
  groupField?: string;
  where: string;
  sourceCount: number;
  zetarisCount: number;
  capped: boolean;
  excludedTestRecords: number;
  sourceUrl: string;
}

const PAGE = 2000;
const MAX_PAGES = 15;

// Each wiring round gets its own table names (Zetaris refuses to redefine a session table).
export async function wire(ctx: Ctx, p: Plan, chosen: Chosen[], revision?: string, version = 1): Promise<Wired[]> {
  const remembered = chosen.flatMap((c) => recall(ctx.memory, `Dataset "${c.candidate.title}" wiring filter fields`, { kinds: ["wiring", "quality"], topN: 2 }));
  ctx.recalled.push(...remembered);
  const { value } = await ctx.models.wirer.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Wirer. For each chosen dataset decide the filter and the fields needed to answer the plan.
ArcGIS layers use SQL-92 where clauses on their own fields (e.g. Year = '2025' when Year is a string, CaseDate >= DATE '2025-01-01' for dates).
Socrata (CDC) datasets use SoQL where clauses (e.g. countyfips = '01101'). The county restriction is added for you; do not add it.
Choose only fields that exist in the dataset's field list. For city records include a field to group counts by if the question asks about kinds of records (e.g. a type field), else null.
Shape: {"sources": [{"measure_id": "m1", "where": "...", "fields": ["..."], "group_field": "..." | null}]}`,
      },
      {
        role: "user",
        content:
          dataBlock("plan", p) +
          "\n" +
          dataBlock(
            "datasets",
            chosen.map((c) => ({ measure_id: c.measureId, measure: c.measure, title: c.candidate.title, kind: c.candidate.kind, fields: c.fields.slice(0, 80) })),
          ) +
          (remembered.length ? "\n" + dataBlock("memory_from_earlier_runs", remembered.map((r) => r.content)) : "") +
          (revision ? `\nThe Evaluator asked: ${revision}` : ""),
      },
    ],
    WiringSchema,
    1500,
  );

  const out: Wired[] = [];
  for (const w of value.sources) {
    const c = chosen.find((x) => x.measureId === w.measure_id);
    if (!c) continue;
    const known = new Set(c.fields.map((f) => f.name));
    const fields = w.fields.filter((f) => known.has(f));
    const label = `${c.measureId}_${c.candidate.kind === "arcgis_layer" ? "city" : "cdc"}${version > 1 ? `_v${version}` : ""}`;
    out.push(c.candidate.kind === "arcgis_layer" ? await wireArcgis(ctx, c, w.where, fields, w.group_field ?? undefined, label) : await wireSocrata(ctx, c, w.where, fields, label));
  }
  return out;
}

async function wireSocrata(ctx: Ctx, c: Chosen, modelWhere: string, fields: string[], label: string): Promise<Wired> {
  const names = new Set(c.fields.map((f) => f.name));
  const county = names.has("countyfips")
    ? `countyfips = '${ctx.cfg.place.stateFips}${ctx.cfg.place.countyFips}'`
    : names.has("countyname") && names.has("stateabbr")
      ? `countyname = '${ctx.cfg.place.countyName}' AND stateabbr = '${ctx.cfg.place.stateAbbr}'`
      : undefined;
  const parts = [county, modelWhere && modelWhere.trim() !== "1=1" ? `(${modelWhere})` : undefined].filter(Boolean);
  const where = parts.join(" AND ");
  const keyFields = ["tractfips", "locationname", "countyfips", "totalpopulation"].filter((f) => names.has(f));
  const select = [...new Set([...keyFields, ...fields])];
  const url = soqlUrl(c.candidate.url, { where: where || undefined, select: select.join(","), limit: 50000 });
  const sourceCount = await socrataCount(c.candidate.url, where || undefined);
  const table = tableName(ctx.runShort, label);
  await register(ctx, table, url, label);
  const z = await ctx.zetaris.query(`SELECT COUNT(*) FROM session.${table}`);
  const zetarisCount = Number(z.rows[0]?.[0] ?? 0);
  await ctx.trace.log({ agent: "wirer", action: "count", status: zetarisCount === sourceCount ? "ok" : "error", note: `${label}: ${zetarisCount} rows in Zetaris, ${sourceCount} at the source`, sql: `SELECT COUNT(*) FROM session.${table}`, zetarisMs: z.ms, rows: zetarisCount });
  return { measureId: c.measureId, measure: c.measure, label, title: c.candidate.title, shape: "socrata_list", tables: [table], fields: select, where, sourceCount, zetarisCount, capped: false, excludedTestRecords: 0, sourceUrl: c.candidate.url };
}

async function wireArcgis(ctx: Ctx, c: Chosen, modelWhere: string, fields: string[], groupField: string | undefined, label: string): Promise<Wired> {
  const layer = normaliseLayerUrl(c.candidate.url);
  let where = modelWhere?.trim() || "1=1";

  // Data-quality rule: exclude values that look like test records in status/type fields (one DEBUG_TEST record seen live).
  let excluded = 0;
  for (const f of c.fields.filter((f) => f.type === "string" && /status|type/i.test(f.name)).slice(0, 3)) {
    const s = (await getJson(statsUrl(layer, where, f.name))) as { features?: { attributes: Record<string, unknown> }[] };
    for (const feat of s.features ?? []) {
      const v = String(feat.attributes[f.name] ?? "");
      const n = Number(feat.attributes["n"] ?? 0);
      if (v && looksLikeTestValue(v)) {
        excluded += n;
        where = `(${where}) AND (${f.name} IS NULL OR ${f.name} <> '${v.replace(/'/g, "''")}')`;
        await ctx.trace.log({ agent: "wirer", action: "data_quality", status: "info", note: `Excluded ${n} record(s) with ${f.name} = '${v}' (looks like test data)` });
      }
    }
  }

  const sourceCount = await layerCount(layer, where);
  const pages = Math.min(Math.ceil(sourceCount / PAGE), MAX_PAGES);
  const outFields = [...new Set(["OBJECTID", ...fields, ...(groupField ? [groupField] : [])])];
  const tables: string[] = [];
  let zetarisCount = 0;
  for (let i = 0; i < pages; i++) {
    const url = featurePageUrl(layer, { where, outFields, offset: i * PAGE, pageSize: PAGE });
    const table = tableName(ctx.runShort, `${label}_p${i}`);
    await register(ctx, table, url, `${label} page ${i + 1} of ${pages}`, i === 0);
    const z = await ctx.zetaris.query(`SELECT COUNT(*) FROM session.${table} LATERAL VIEW explode(features) AS f`);
    zetarisCount += Number(z.rows[0]?.[0] ?? 0);
    tables.push(table);
  }
  const capped = sourceCount > pages * PAGE;
  await ctx.trace.log({
    agent: "wirer",
    action: "count",
    status: capped || zetarisCount === sourceCount ? "ok" : "error",
    note: `${label}: ${zetarisCount.toLocaleString("en-US")} records read through Zetaris in ${pages} page(s); the city's server reports ${sourceCount.toLocaleString("en-US")}${capped ? " (more than Fieldwork reads in one run)" : ""}`,
    rows: zetarisCount,
  });
  return { measureId: c.measureId, measure: c.measure, label, title: c.candidate.title, shape: "arcgis_features", tables, fields: outFields, groupField, where, sourceCount, zetarisCount, capped, excludedTestRecords: excluded, sourceUrl: layer };
}

// Test the request first; only then create the table Zetaris will query.
async function register(ctx: Ctx, table: string, url: string, what: string, test = true): Promise<void> {
  if (test) {
    const tsql = testRequest(url);
    const t = await ctx.zetaris.query(tsql, 50);
    const status = t.rows.find((r) => r[0] === "STATUS" && r[1] === "code")?.[2];
    await ctx.trace.log({ agent: "wirer", action: "test_request", status: status === "200" ? "ok" : "error", note: `${what}: source answered HTTP ${status ?? "?"} through Zetaris`, sql: tsql, zetarisMs: t.ms });
    if (status !== "200") throw new ZetarisError(`${what}: the source answered HTTP ${status ?? "?"}`, Number(status ?? 0), tsql);
  }
  const csql = createSessionTable(table, url);
  const check = checkSql(csql, "wirer");
  if (!check.ok) throw new Error(`refused to send SQL: ${check.reason}`);
  const r = await ctx.zetaris.query(csql);
  await ctx.trace.log({ agent: "wirer", action: "create_table", status: "ok", note: `${what}: registered in Zetaris as session.${table}`, sql: csql, zetarisMs: r.ms });
}
