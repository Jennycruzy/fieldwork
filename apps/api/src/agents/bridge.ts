import { bridge as placeInTracts, tractPolygonsUrl, type PointRec, type Tract } from "@fieldwork/sources";
import { createSessionTable, quoteIdent, tableName, checkSql } from "@fieldwork/zetaris";
import type { Ctx } from "./context.js";
import type { Wired } from "./wirer.js";

export interface Bridged {
  label: string;
  matched: number;
  unmatched: number;
  invalid: number;
  total: number;
  tractsWithRecords: number;
  duplicates: number;
}

const tractCache = new Map<string, Tract[]>(); // per run: shapes are read once and reused by every source

async function tracts(ctx: Ctx): Promise<Tract[]> {
  const cached = tractCache.get(ctx.runId);
  if (cached) return cached;
  const tractsTable = tableName(ctx.runShort, "tract_shapes");
  const csql = createSessionTable(tractsTable, tractPolygonsUrl(ctx.cfg.place.stateFips, ctx.cfg.place.countyFips));
  await ctx.zetaris.query(csql);
  const sql = `SELECT f.attributes.GEOID AS geoid, to_json(f.geometry.rings) AS rings FROM session.${tractsTable} LATERAL VIEW explode(features) AS f`;
  const r = await ctx.zetaris.query(sql, 500);
  await ctx.trace.log({ agent: "bridge", action: "read_tracts", status: "ok", note: `Read ${r.rows.length} census tract boundaries from the Census Bureau through Zetaris`, sql, zetarisMs: r.ms, rows: r.rows.length });
  const shapes = r.rows.map(([geoid, rings]) => ({ geoid: geoid!, rings: JSON.parse(rings!) as number[][][] }));
  ctx.tractShapes = shapes;
  tractCache.set(ctx.runId, shapes);
  return shapes;
}

export async function bridgeToTracts(ctx: Ctx, w: Wired): Promise<Bridged> {
  const shapes = await tracts(ctx);
  if(ctx.world) for(const t of shapes) await ctx.world.upsertEntity({type:"tract",externalKey:{system:"census",id:t.geoid},attrs:{geoid:t.geoid},source:{kind:"bridge",at:ctx.today.toISOString()}});
  const group = w.groupField ? `, f.attributes.${quoteIdent(w.groupField)} AS grp` : "";
  const points: PointRec[] = [];
  for (const t of w.tables) {
    const sql = `SELECT f.attributes.${quoteIdent(w.objectIdField ?? "OBJECTID")} AS id, f.geometry.x AS lon, f.geometry.y AS lat${group}${w.caseIdField ? `, f.attributes.${quoteIdent(w.caseIdField)} AS case_id` : ""} FROM session.${t} LATERAL VIEW explode(features) AS f`;
    const chk = checkSql(sql, "reader");
    if (!chk.ok) throw new Error(`refused to send SQL: ${chk.reason}`);
    const r = await ctx.zetaris.query(sql, 2500);
    for (const row of r.rows) points.push({ id: row[0]!, lon: row[1] == null ? NaN : Number(row[1]), lat: row[2] == null ? NaN : Number(row[2]), caseId: w.caseIdField ? row[w.groupField ? 4:3] ?? undefined:undefined, group: w.groupField ? row[3] ?? "unknown" : undefined });
  }
  const res = placeInTracts(shapes, points);
  await ctx.trace.log({agent:"bridge",action:"duplicates",status:"info",note:`${res.duplicates} duplicate case IDs removed; distinct records counted once. ${w.caseIdField ? `Case key: ${w.caseIdField}; first OBJECTID retained.` : "Record key: OBJECTID."}`});

  await ctx.db.query(`DELETE FROM tract_counts WHERE run_id = $1 AND source = $2`, [ctx.runId, w.label]);
  // grp = 'all' always holds the tract's total; grouped sources add one row per group value as well.
  for (const [geoid, byGroup] of res.counts) {
    const rows = new Map<string, number>();
    let total = 0;
    for (const [grp, n] of byGroup) {
      total += n;
      if (grp !== "all") rows.set(grp, n);
    }
    rows.set("all", total);
    for (const [grp, n] of rows) {
      await ctx.db.query(`INSERT INTO tract_counts (run_id, source, geoid, grp, n) VALUES ($1,$2,$3,$4,$5)`, [ctx.runId, w.label, geoid, grp, n]);
    }
  }
  await ensureRegistered(ctx);
  await ctx.trace.log({
    agent: "bridge",
    action: "place_in_tracts",
    status: "ok",
    note: `Placed ${res.matched.toLocaleString("en-US")} of ${res.total.toLocaleString("en-US")} ${w.measure} records into ${res.counts.size} tracts (${res.unmatched} outside the county's tracts, ${res.invalid} without a location). Counts saved to fw_pg.tract_counts for Zetaris.`,
    rows: res.matched,
  });
  return { label: w.label, matched: res.matched, unmatched: res.unmatched, invalid: res.invalid, total: res.total, tractsWithRecords: res.counts.size, duplicates: res.duplicates };
}

async function ensureRegistered(ctx: Ctx): Promise<void> {
  const r = await ctx.zetaris.query("SHOW DATASOURCE TABLES fw_pg");
  if (r.rows.some((row) => row[0] === "tract_counts")) return;
  const sql = `REGISTER DATASOURCE TABLE "tract_counts" FROM fw_pg`;
  await ctx.zetaris.query(sql);
  await ctx.trace.log({ agent: "bridge", action: "register", status: "ok", note: "Registered Fieldwork's tract counts table in Zetaris", sql });
}

export async function bridgeEpa(ctx: Ctx,w: Wired): Promise<Bridged> {
  await tracts(ctx);
  const sql=`SELECT f.RegistryID, f.FacLong, f.FacLat FROM session.${w.tables[0]} LATERAL VIEW explode(Results.Facilities) AS f`;
  const result=await ctx.zetaris.query(sql,10000);
  const res=placeInTracts(ctx.tractShapes ?? [],result.rows.map(([id,lon,lat])=>({id:id!,caseId:id!,lon:lon==null?NaN:Number(lon),lat:lat==null?NaN:Number(lat)})));
  const {invalid,unmatched,duplicates,matched}=res;
  const counts=new Map([...res.counts].map(([geoid,groups])=>[geoid,[...groups.values()].reduce((a,b)=>a+b,0)]));
  await ctx.db.query(`DELETE FROM tract_counts WHERE run_id=$1 AND source=$2`,[ctx.runId,w.label]);
  for(const [geoid,n] of counts) await ctx.db.query(`INSERT INTO tract_counts (run_id,source,geoid,grp,n) VALUES ($1,$2,$3,'all',$4)`,[ctx.runId,w.label,geoid,n]);
  await ensureRegistered(ctx);
  await ctx.trace.log({agent:"bridge",action:"place_in_tracts",status:"ok",note:`EPA registry: ${matched} facilities placed from source coordinates; ${invalid} without coordinates, ${unmatched} outside the county, ${duplicates} duplicate registry IDs removed. EPA coordinate accuracy varies; locations near tract boundaries are approximate. This is a registry count, not emissions or exposure.`,sql,rows:matched});
  return {label:w.label,matched,invalid,unmatched,duplicates,total:result.rows.length-duplicates,tractsWithRecords:counts.size};
}
