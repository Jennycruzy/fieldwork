import { bridge as placeInTracts, tractPolygonsUrl, type PointRec, type Tract, observation, type Observation } from "@fieldwork/sources";
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

export async function bridgeToTracts(ctx: Ctx, w: Wired, place=true): Promise<Bridged> {
  const shapes = place ? await tracts(ctx) : [];
  if(ctx.world) for(const t of shapes) await ctx.world.upsertEntity({type:"tract",externalKey:{system:"census",id:t.geoid},attrs:{geoid:t.geoid},source:{kind:"bridge",at:ctx.today.toISOString()}});
  const points: PointRec[] = [];
  const details = new Map<string,Observation>();
  const roles=[w.dateField,w.yearField,w.monthField,w.categoryField,w.valueField,w.entityField,w.entityLocationField];
  const attribute=(field:string|undefined)=>field?`CAST(f.attributes.${quoteIdent(field)} AS STRING)`:"CAST(NULL AS STRING)";
  for(const table of w.tables) {
    const location=w.shape==="arcgis_table"?"CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)":"f.geometry.x, f.geometry.y";
    const sql=`SELECT ${attribute(w.objectIdField??"OBJECTID")}, ${location}, ${attribute(w.groupField)}, ${attribute(w.caseIdField)}, ${roles.map(attribute).join(", ")} FROM session.${table} LATERAL VIEW explode(features) AS f`;
    const check=checkSql(sql,"reader");if(!check.ok)throw new Error(check.reason);
    const result=await ctx.zetaris.query(sql,2500);
    for(const row of result.rows) {
      const id=row[0]!;points.push({id,lon:row[1]==null?NaN:Number(row[1]),lat:row[2]==null?NaN:Number(row[2]),group:row[3]??undefined,caseId:row[4]??undefined});
      details.set(id,observation(id,null,{date:row[5],year:row[6],month:row[7],category:row[8],value:row[9],entity:row[10],entityLocation:row[11],valueKind:w.valueKind}));
    }
  }
  const res = placeInTracts(shapes, points);
  const observations=[...details].filter(([id])=>res.retained.has(id)).map(([id,row])=>({...row,geoid:res.assignments.get(id)??null}));
  await ctx.db.query(`DELETE FROM tract_observations WHERE run_id=$1 AND source=$2`,[ctx.runId,w.label]);
  await ctx.db.query(`INSERT INTO tract_observations (run_id,source,record_id,geoid,entity_key,event_date,year,month,category,value,value_kind)
    SELECT $1,$2,x.record_id,x.geoid,x.entity_key,x.event_date,x.year,x.month,x.category,x.value,x.value_kind
    FROM jsonb_to_recordset($3::jsonb) AS x(record_id text,geoid text,entity_key text,event_date text,year int,month int,category text,value double precision,value_kind text)`,[ctx.runId,w.label,JSON.stringify(observations)]);
  w.normalized=true;
  await ctx.trace.log({agent:"bridge",action:"normalize_records",status:"ok",note:`Saved ${observations.length} de-identified observations for date, category and numeric aggregation; personal names and addresses are not retained.`,rows:observations.length});
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
  const from=`fw_pg.tract_observations WHERE run_id='${ctx.runId}' AND source='${w.label}'`;
  const coverage=await ctx.zetaris.query(`SELECT MIN(event_date),MAX(event_date) FROM ${from}`);
  const months=await ctx.zetaris.query(`SELECT year,month FROM ${from} GROUP BY year,month`,1000);
  const periods=months.rows.filter(r=>r[0]!=null&&r[1]!=null).map(r=>Number(r[0])*100+Number(r[1]));
  const [earliest,latest]=coverage.rows[0]??[];
  w.coverage={earliest:earliest??null,latest:latest??null,firstPeriod:periods.length?Math.min(...periods):null,lastPeriod:periods.length?Math.max(...periods):null,periods:periods.length};
  await ctx.trace.log({
    agent: "bridge",
    action: place ? "place_in_tracts":"normalize_summary",
    status: "ok",
    note: place ? `Placed ${res.matched.toLocaleString("en-US")} of ${res.total.toLocaleString("en-US")} ${w.measure} records into ${res.counts.size} tracts (${res.unmatched} outside the county's tracts, ${res.invalid} without a location). Counts saved to fw_pg.tract_counts for Zetaris.` : `Normalized ${res.total} source records for a citywide summary; no tract membership is inferred.`,
    rows: res.matched,
  });
  return { label: w.label, matched: res.matched, unmatched: res.unmatched, invalid: res.invalid, total: res.total, tractsWithRecords: res.counts.size, duplicates: res.duplicates };
}

async function ensureRegistered(ctx: Ctx): Promise<void> {
 const existing=await ctx.zetaris.query("SHOW DATASOURCE TABLES fw_pg");
 for(const table of ["tract_counts","tract_observations"]) if(!existing.rows.some(r=>r[0]===table)) {
  await ctx.zetaris.query(`REGISTER DATASOURCE TABLE "${table}" FROM fw_pg`);
  await ctx.trace.log({agent:"bridge",action:"register",status:"ok",note:`Registered Fieldwork's ${table} table in Zetaris.`});
 }
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
