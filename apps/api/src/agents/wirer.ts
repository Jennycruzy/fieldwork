import { WiringSchema, looksLikeTestValue, notice, FieldworkError, type Plan } from "@fieldwork/core";
import { checkSql, createSessionTable, tableName, testRequest, type Shape } from "@fieldwork/zetaris";
import {
  featurePageUrl,
  observationRoles,
  inspectionSourceWhere,
  typedWhere,
  withoutPostalFilters,
  getJson,
  layerCount,
  normaliseLayerUrl,
  socrataCount,
  soqlUrl,
  statsUrl,
} from "@fieldwork/sources";
import { recall } from "@fieldwork/hmem";
import { shared, provenance, SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
import type { Chosen } from "./finder.js";

export interface Wired {
  measureId: string;
  measure: string;
  label: string;
  title: string;
  shape: Shape;
  tables: string[]; // one per page for paged sources
  fields: string[];
  objectIdField?: string;
  licence?: string;
  licenceUrl?: string;
  caseIdField?: string;
  groupField?: string;
  dateField?: string;
  yearField?: string;
  monthField?: string;
  categoryField?: string;
  valueField?: string;
  entityField?: string;
  entityLocationField?: string;
  valueKind?: string;
  normalized?: boolean;
  accessedAt?: string;
  catalogUpdatedAt?: string;
  catalogDescription?: string;
  coverage?: {
    earliest: string | null;
    latest: string | null;
    firstPeriod: number | null;
    lastPeriod: number | null;
    periods: number;
  };
  where: string;
  sourceCount: number;
  zetarisCount: number;
  capped: boolean;
  excludedTestRecords: number;
  sourceUrl: string;
}

const PAGE = 2000;
const privateField = /owner|contractor|address|phone|email|complaint|remark|description/i;

// Each wiring round gets its own table names (Zetaris refuses to redefine a session table).
export async function wire(
  ctx: Ctx,
  p: Plan,
  chosen: Chosen[],
  revision?: string,
  version = 1,
): Promise<Wired[]> {
  const signature = JSON.stringify({
    plan: p,
    chosen: chosen.map((c) => [c.measureId, c.candidate.url, c.fields, c.geometryType]),
    version,
  });
  const cached = ctx.world?.entities().find((e) => e.id === `wiring:${ctx.runId}:verified`);
  if (
    !revision &&
    cached?.attrs.runId === ctx.runId &&
    cached.attrs.signature === signature &&
    Array.isArray(cached.attrs.wired)
  ) {
    await ctx.trace.log({
      agent: "wirer",
      action: "world_reuse",
      status: "ok",
      note: "Reused this run's verified wiring from the World Model; plan, source fields and revision match.",
    });
    return structuredClone(cached.attrs.wired) as Wired[];
  }
  const remembered = chosen.flatMap((c) =>
    recall(ctx.memory, `Dataset "${c.candidate.title}" wiring filter fields`, {
      kinds: ["wiring", "quality"],
      topN: 2,
    }),
  );
  ctx.recalled.push(...remembered);
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    {
      role: "system",
      content: `${SYSTEM_BASE}
You are the Wirer. For each chosen dataset decide the filter and the fields needed to answer the plan.
ArcGIS layers use SQL-92 where clauses on their own fields (e.g. Year = '2025' when Year is a string, CaseDate >= DATE '2025-01-01' for dates).
Socrata (CDC) datasets use SoQL where clauses (e.g. countyfips = '01101'). The county restriction is added for you; do not add it.
Do not add postal City/STATE restrictions: the spatial bridge determines county tract membership. Do not remove null statuses or categories unless the request explicitly asks for them.
For latest-inspection questions, retrieve all inspections in the requested period. Apply any score threshold only after selecting the latest inspection per establishment in the analysis query. Choose only fields that exist in the dataset's field list. For city records include a field to group counts by if the question asks about kinds of records (e.g. a type field), else null.
Shape: {"sources": [{"measure_id": "m1", "where": "...", "fields": ["..."], "group_field": "..." | null}]}`,
    },
    {
      role: "user",
      content:
        shared(ctx) +
        dataBlock("plan", p) +
        "\n" +
        dataBlock(
          "datasets",
          chosen.map((c) => ({
            measure_id: c.measureId,
            measure: c.measure,
            title: c.candidate.title,
            kind: c.candidate.kind,
            fields: c.fields.slice(0, 80),
          })),
        ) +
        (remembered.length
          ? "\n" +
            dataBlock(
              "memory_from_earlier_runs",
              remembered.map((r) => r.content),
            )
          : "") +
        (revision ? `\nThe Evaluator asked: ${revision}` : ""),
    },
  ];
  const { value } = await ctx.models.wirer.json(messages, WiringSchema, 1500);

  const build = async (w: (typeof value.sources)[number]): Promise<Wired | undefined> => {
    const c = chosen.find((x) => x.measureId === w.measure_id);
    if (!c) return undefined;
    const known = new Set(c.fields.map((f) => f.name));
    const fields = w.fields.filter((f) => known.has(f) && !privateField.test(f));
    const label = `${c.measureId}_${c.candidate.kind === "arcgis_layer" ? "city" : "cdc"}${version > 1 ? `_v${version}` : ""}`;
    if (p.geography === "tract" && c.candidate.kind === "arcgis_layer" && !c.geometryType)
      throw new FieldworkError("NO_SOURCE", {
        source: c.candidate.title,
        reason: "publishes no tract locations, so tract counts cannot be inferred.",
      });
    const roles = observationRoles(c.fields, !!c.geometryType);
    const request = String(
      ctx.world?.entities().find((e) => e.type === "run")?.attrs.question ??
        p.measures.map((m) => m.describe).join(" "),
    );
    const sourceWhere = roles.valueKind === "score" ? inspectionSourceWhere(w.where, request) : w.where;
    if (sourceWhere !== w.where)
      await ctx.trace.log({
        agent: "wirer",
        action: "filter_alignment",
        status: "info",
        note: "Retrieve inspection histories before selecting latest scores; unrequested status and score filters were removed.",
      });
    return c.candidate.kind === "epa_facilities"
      ? await wireEpa(ctx, p, c, label)
      : c.candidate.kind === "arcgis_layer"
        ? await wireArcgis(
            ctx,
            c,
            sourceWhere,
            fields,
            w.group_field && known.has(w.group_field) && !privateField.test(w.group_field)
              ? w.group_field
              : undefined,
            label,
          )
        : await wireSocrata(ctx, c, w.where, fields, label);
  };
  const out: Wired[] = [];
  for (const w of value.sources) {
    let built: Wired | undefined;
    try {
      built = await build(w);
    } catch (error) {
      if (!/ArcGIS did not return a count: 400/.test((error as Error).message)) throw error;
      await ctx.trace.log({
        agent: "wirer",
        action: "filter_error",
        status: "error",
        note: JSON.stringify({ measure: w.measure_id, where: w.where, error: (error as Error).message }),
      });
      const again = await ctx.models.wirer.json(
        [
          ...messages,
          { role: "assistant", content: JSON.stringify(value) },
          {
            role: "user",
            content:
              "The source rejected the filter " +
              JSON.stringify(w.where) +
              " for measure " +
              w.measure_id +
              ": " +
              (error as Error).message +
              ". Repair that filter using only the listed fields and their exact types; ArcGIS SQL-92 supports date ranges, not arbitrary SQL functions. Keep the requested time period and do not broaden it. Return the complete required shape.",
          },
        ],
        WiringSchema,
        1500,
      );
      const fixed = again.value.sources.find((s) => s.measure_id === w.measure_id);
      if (!fixed) throw error;
      built = await build(fixed);
    }
    if (built) out.push(built);
  }
  // A filter that matched nothing on a source that has records gets one more try, with the source's real values
  // (models guess category values a layer does not have, such as shelter TYPE codes).
  const hints = await emptyFilterHints(chosen, out);
  if (hints.size) {
    await ctx.trace.log({
      agent: "wirer",
      action: "filter_values",
      status: "info",
      note: [...hints.values()].join(" "),
    });
    const again = await ctx.models.wirer.json(
      [
        ...messages,
        { role: "assistant", content: JSON.stringify(value) },
        {
          role: "user",
          content: `${[...hints.values()].join("\n")}\nReturn the full shape again. Filter only on values that exist in the source, or use no category filter when none of them fits the request.`,
        },
      ],
      WiringSchema,
      1500,
    );
    for (const w of again.value.sources) {
      const i = out.findIndex((o) => o.measureId === w.measure_id);
      if (i < 0 || !hints.has(w.measure_id)) continue;
      const built = await build(w);
      if (built) out[i] = built;
    }
  }
  for (const w of out) {
    const c = chosen.find((c) => c.measureId === w.measureId);
    w.accessedAt = new Date().toISOString();
    w.catalogUpdatedAt = c?.candidate.modified;
    w.catalogDescription = c?.candidate.description;
    w.licence = c?.candidate.licence ?? "No license statement supplied by the source API";
    w.licenceUrl = c?.candidate.licenceUrl ?? c?.candidate.url;
  }
  if (ctx.world)
    for (const w of out) {
      const source = provenance(ctx, "wirer");
      const entity = await ctx.world.upsertEntity({
        type: "source",
        externalKey: { system: ctx.runId, id: w.label },
        attrs: {
          title: w.title,
          url: w.sourceUrl,
          tables: w.tables,
          filter: w.where,
          fields: w.fields,
          records: w.zetarisCount,
        },
        source,
      });
      const measure = ctx.world
        .entities()
        .find((e) => e.type === "measure" && e.id.endsWith(`:${w.measureId}`));
      if (measure) await ctx.world.relate({ from: measure.id, type: "wired as", to: entity.id, source });
    }
  if (ctx.world)
    await ctx.world.upsertContext({
      type: "wiring",
      externalKey: { system: ctx.runId, id: "verified" },
      attrs: { runId: ctx.runId, signature, wired: out },
      source: provenance(ctx, "wirer"),
    });
  return out;
}

async function wireSocrata(
  ctx: Ctx,
  c: Chosen,
  modelWhere: string,
  fields: string[],
  label: string,
): Promise<Wired> {
  const names = new Set(c.fields.map((f) => f.name));
  const county = names.has("countyfips")
    ? `countyfips = '${ctx.cfg.place.stateFips}${ctx.cfg.place.countyFips}'`
    : names.has("countyname") && names.has("stateabbr")
      ? `countyname = '${ctx.cfg.place.countyName}' AND stateabbr = '${ctx.cfg.place.stateAbbr}'`
      : undefined;
  const parts = [county, modelWhere && modelWhere.trim() !== "1=1" ? `(${modelWhere})` : undefined].filter(
    Boolean,
  );
  const where = parts.join(" AND ");
  const keyFields = [
    "tractfips",
    "locationname",
    "countyfips",
    "countyname",
    "stateabbr",
    "totalpopulation",
    "totalpop18plus",
  ].filter((f) => names.has(f));
  const intervals = fields
    .flatMap((f) => (f.endsWith("_crudeprev") ? [f.replace(/_crudeprev$/, "_crude95ci")] : []))
    .filter((f) => names.has(f));
  const select = [...new Set([...keyFields, ...fields, ...intervals])];
  const url = soqlUrl(c.candidate.url, { where: where || undefined, select: select.join(","), limit: 50000 });
  const sourceCount = await socrataCount(c.candidate.url, where || undefined);
  const table = tableName(ctx.runShort, label);
  await register(ctx, table, url, label);
  const z = await ctx.zetaris.query(`SELECT COUNT(*) FROM session.${table}`);
  const zetarisCount = Number(z.rows[0]?.[0] ?? 0);
  if (intervals.length) {
    const ci = await ctx.zetaris.query(
      `SELECT tractfips, ${intervals.join(", ")} FROM session.${table}`,
      200,
    );
    (ctx.intervals ??= []).push({ source: c.candidate.title, headers: ci.headers, rows: ci.rows });
  }
  await ctx.trace.log({
    agent: "wirer",
    action: "count",
    status: zetarisCount === sourceCount ? "ok" : "error",
    note: `${label}: ${zetarisCount} rows in Zetaris, ${sourceCount} at the source`,
    sql: `SELECT COUNT(*) FROM session.${table}`,
    zetarisMs: z.ms,
    rows: zetarisCount,
  });
  return {
    measureId: c.measureId,
    measure: c.measure,
    label,
    title: c.candidate.title,
    shape: "socrata_list",
    tables: [table],
    fields: select,
    where,
    sourceCount,
    zetarisCount,
    capped: false,
    excludedTestRecords: 0,
    sourceUrl: c.candidate.url,
  };
}

export async function emptyFilterHints(chosen: Chosen[], out: Wired[]): Promise<Map<string, string>> {
  const hints = new Map<string, string>();
  for (const o of out) {
    const c = chosen.find((x) => x.measureId === o.measureId);
    if (
      !c ||
      c.candidate.kind !== "arcgis_layer" ||
      o.sourceCount !== 0 ||
      !o.where ||
      o.where.trim() === "1=1"
    )
      continue;
    const layer = normaliseLayerUrl(c.candidate.url);
    const total = await layerCount(layer, "1=1");
    if (!total) continue;
    const parts: string[] = [];
    for (const f of c.fields
      .filter((f) => f.type === "string" && new RegExp(`\\b${f.name}\\b`, "i").test(o.where))
      .slice(0, 3)) {
      const s = (await getJson(statsUrl(layer, "1=1", f.name))) as {
        features?: { attributes: Record<string, unknown> }[];
      };
      const values = (s.features ?? [])
        .map((x) => ({ v: String(x.attributes[f.name] ?? ""), n: Number(x.attributes.n ?? 0) }))
        .filter((x) => x.v)
        .sort((a, b) => b.n - a.n)
        .slice(0, 25);
      if (values.length)
        parts.push(`${f.name} values in the source: ${values.map((x) => `'${x.v}' (${x.n})`).join(", ")}.`);
    }
    hints.set(
      o.measureId,
      `The filter ${o.where} on "${o.title}" matched 0 of its ${total.toLocaleString("en-US")} records.${parts.length ? " " + parts.join(" ") : ""}`,
    );
  }
  return hints;
}

export async function wireArcgis(
  ctx: Ctx,
  c: Chosen,
  modelWhere: string,
  fields: string[],
  groupField: string | undefined,
  label: string,
): Promise<Wired> {
  const layer = normaliseLayerUrl(c.candidate.url);
  const objectIdField = c.fields.find((f) => f.type === "oid")?.name ?? "OBJECTID";
  const pageSize = Math.min(PAGE, c.maxRecordCount ?? PAGE);
  let where = typedWhere(modelWhere?.trim() || "1=1", c.fields);
  const aligned = withoutPostalFilters(where);
  if (aligned !== where) {
    where = aligned || "1=1";
    await ctx.trace.log({
      agent: "wirer",
      action: "filter_alignment",
      status: "info",
      note: "Postal city/state labels do not define tract geography; membership is checked against the county tract boundaries.",
    });
  }

  // Data-quality rule: exclude values that look like test records in status/type fields (one DEBUG_TEST record seen live).
  let excluded = 0;
  for (const f of c.fields.filter((f) => f.type === "string" && /status|type/i.test(f.name)).slice(0, 3)) {
    const s = (await getJson(statsUrl(layer, where, f.name))) as {
      features?: { attributes: Record<string, unknown> }[];
    };
    for (const feat of s.features ?? []) {
      const v = String(feat.attributes[f.name] ?? "");
      const n = Number(feat.attributes["n"] ?? 0);
      if (v && looksLikeTestValue(v)) {
        excluded += n;
        where = `(${where}) AND (${f.name} IS NULL OR ${f.name} <> '${v.replace(/'/g, "''")}')`;
        await ctx.trace.log({
          agent: "wirer",
          action: "data_quality",
          status: "info",
          note: `Excluded ${n} record(s) with ${f.name} = '${v}' (looks like test data)`,
        });
      }
    }
  }

  const sourceCount = await layerCount(layer, where);
  const pages = Math.ceil(sourceCount / pageSize);
  const caseIdField = c.fields.find((f) =>
    /^(OffenceNum|CaseID|CaseNumber|CaseNo|Request_?ID|IncidentID|PermitNo)$/i.test(f.name),
  )?.name;
  const {
    dateField,
    yearField,
    monthField,
    categoryField,
    valueField,
    valueKind,
    entityField,
    entityLocationField,
  } = observationRoles(c.fields, !!c.geometryType, groupField);
  const roles = [
    dateField,
    yearField,
    monthField,
    categoryField,
    valueField,
    entityField,
    entityLocationField,
  ].filter((x): x is string => !!x);
  const outFields = [
    ...new Set([
      objectIdField,
      ...roles,
      ...(caseIdField ? [caseIdField] : []),
      ...fields,
      ...(groupField ? [groupField] : []),
    ]),
  ];
  const tables: string[] = [];
  let zetarisCount = 0;
  for (let i = 0; i < pages; i++) {
    const url = featurePageUrl(layer, { where, outFields, offset: i * pageSize, pageSize, objectIdField });
    const table = tableName(ctx.runShort, `${label}_p${i}`);
    await register(ctx, table, url, `${label} page ${i + 1} of ${pages}`, i === 0);
    const z = await ctx.zetaris.query(
      `SELECT COUNT(*) FROM session.${table} LATERAL VIEW explode(features) AS f`,
    );
    zetarisCount += Number(z.rows[0]?.[0] ?? 0);
    tables.push(table);
  }
  const capped = sourceCount > pages * pageSize;
  await ctx.trace.log({
    agent: "wirer",
    action: "count",
    status: capped || zetarisCount === sourceCount ? "ok" : "error",
    note: `${label}: ${zetarisCount.toLocaleString("en-US")} records read through Zetaris in ${pages} page(s); the city's server reports ${sourceCount.toLocaleString("en-US")}${capped ? " (more than Fieldwork reads in one run)" : ""}`,
    rows: zetarisCount,
  });
  return {
    measureId: c.measureId,
    measure: c.measure,
    label,
    title: c.candidate.title,
    shape: c.geometryType ? "arcgis_features" : "arcgis_table",
    dateField,
    yearField,
    monthField,
    categoryField,
    valueField,
    valueKind,
    entityField,
    entityLocationField,
    objectIdField,
    tables,
    fields: outFields,
    caseIdField,
    groupField,
    where,
    sourceCount,
    zetarisCount,
    capped,
    excludedTestRecords: excluded,
    sourceUrl: layer,
  };
}

// Test the request first; only then create the table Zetaris will query.
async function register(ctx: Ctx, table: string, url: string, what: string, test = true): Promise<void> {
  if (test) {
    const tsql = testRequest(url);
    let t = await ctx.zetaris.query(tsql, 50);
    const initial = t.rows.find((r) => r[0] === "STATUS" && r[1] === "code")?.[2];
    if (initial !== "200") {
      await ctx.trace.log({
        agent: "wirer",
        action: "SOURCE_DOWN",
        status: "info",
        note: notice("SOURCE_DOWN", `${what}: HTTP ${initial ?? "unknown"}; retrying.`).message,
      });
      t = await ctx.zetaris.query(tsql, 50);
      if (t.rows.find((r) => r[0] === "STATUS" && r[1] === "code")?.[2] === "200")
        await ctx.trace.log({
          agent: "wirer",
          action: "SOURCE_REPAIRED",
          status: "ok",
          note: notice("SOURCE_REPAIRED", what).message,
        });
    }
    const status = t.rows.find((r) => r[0] === "STATUS" && r[1] === "code")?.[2];
    await ctx.trace.log({
      agent: "wirer",
      action: "test_request",
      status: status === "200" ? "ok" : "error",
      note: `${what}: source answered HTTP ${status ?? "?"} through Zetaris`,
      sql: tsql,
      zetarisMs: t.ms,
    });
    if (status !== "200") throw new FieldworkError("SOURCE_DOWN", `${what}: HTTP ${status ?? "unknown"}.`);
  }
  const csql = createSessionTable(table, url);
  const check = checkSql(csql, "wirer");
  if (!check.ok) throw new Error(`refused to send SQL: ${check.reason}`);
  const r = await ctx.zetaris.query(csql);
  await ctx.trace.log({
    agent: "wirer",
    action: "create_table",
    status: "ok",
    note: `${what}: registered in Zetaris as session.${table}`,
    sql: csql,
    zetarisMs: r.ms,
  });
}

async function wireEpa(ctx: Ctx, p: Plan, c: Chosen, label: string): Promise<Wired> {
  if (p.years?.from || p.years?.to)
    throw new FieldworkError(
      "NO_SOURCE",
      "EPA ECHO is a current registry snapshot; this source does not establish the requested historical period.",
    );
  const table = tableName(ctx.runShort, label);
  await register(ctx, table, c.candidate.url, label);
  const sql = `SELECT COUNT(*) AS n FROM session.${table} LATERAL VIEW explode(Results.Facilities) AS f`;
  const result = await ctx.zetaris.query(sql);
  const n = Number(result.rows[0]?.[0] ?? 0);
  const expected = Number(c.candidate.description.match(/(\d+) source records/)?.[1] ?? n);
  if (n !== expected)
    throw new FieldworkError(
      "NO_SOURCE",
      `EPA returned ${n} of ${expected} records; incomplete registry coverage cannot support a tract ranking.`,
    );
  await ctx.trace.log({
    agent: "wirer",
    action: "count",
    status: "ok",
    note: `EPA ECHO: ${n} of ${expected} records through Zetaris; current county registry, not historical emissions.`,
    sql,
    rows: n,
  });
  return {
    measureId: c.measureId,
    measure: c.measure,
    label,
    title: c.candidate.title,
    shape: "epa_facilities",
    tables: [table],
    fields: c.fields.map((f) => f.name),
    where: "current county registry",
    sourceCount: expected,
    zetarisCount: n,
    capped: false,
    excludedTestRecords: 0,
    sourceUrl: c.candidate.url,
  };
}
