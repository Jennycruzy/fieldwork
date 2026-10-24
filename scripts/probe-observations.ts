import {randomBytes} from "node:crypto";
import {writeFileSync} from "node:fs";
import {config,loadEnvFile} from "../apps/api/src/config.js";
import {openDb,migrate} from "../apps/api/src/db.js";
import {Trace} from "../apps/api/src/trace.js";
import {bridgeToTracts} from "../apps/api/src/agents/bridge.js";
import type {Ctx} from "../apps/api/src/agents/context.js";
import type {Wired} from "../apps/api/src/agents/wirer.js";
import {ZetarisClient,createSessionTable} from "../packages/zetaris/src/index.js";
import {searchMontgomeryHub,layerInfo,layerCount,featurePageUrl,observationRoles} from "../packages/sources/src/index.js";
loadEnvFile();const cfg=config(),db=openDb(cfg.pgUrl),z=new ZetarisClient(cfg.zetaris);const output=[];
try {
 await migrate(db);
 for(const term of ["food","911"]) {
  const c=(await searchMontgomeryHub(term))[0]!;const info=await layerInfo(c.url);const roles=observationRoles(info.fields,!!info.geometryType);const oid=info.fields.find(f=>f.type==="esriFieldTypeOID")!.name;
  const where=info.fields.some(f=>f.name==="Year")?"Year=2025":"1=1";const total=await layerCount(c.url,where);const fields=[oid,...Object.entries(roles).filter(([k,v])=>k.endsWith("Field")&&v).map(([,v])=>v!)];const short=randomBytes(3).toString("hex"),runId=`r_${new Date().toISOString().slice(0,10).replace(/-/g,"")}_${short}`;
  await db.query("INSERT INTO runs(id,question,status) VALUES($1,$2,'probe')",[runId,`Live source normalization probe: ${c.title}`]);
  const tables=[];const pageSize=Math.min(info.maxRecordCount,2000);
  for(let offset=0;offset<total;offset+=pageSize) {const table=`fw_probe_${short}_${offset}`;await z.query(createSessionTable(table,featurePageUrl(c.url,{where,outFields:fields,objectIdField:oid,offset,pageSize})));tables.push(table);}
  const wired:Wired={measureId:"probe",measure:c.title,label:"probe",title:c.title,sourceUrl:c.url,shape:info.geometryType?"arcgis_features":"arcgis_table",fields,tables,objectIdField:oid,where,sourceCount:total,zetarisCount:total,capped:false,excludedTestRecords:0,...roles};
  const ctx={cfg,db,zetaris:z,runId,runShort:short,today:new Date(),trace:new Trace(db,runId)} as Ctx;
  const result=await bridgeToTracts(ctx,wired,!!info.geometryType);
  const sql=`SELECT COUNT(*) AS observations,MIN(event_date) AS earliest,MAX(event_date) AS latest,MIN(value) AS min_value,MAX(value) AS max_value,COUNT(DISTINCT entity_key) AS entities FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe'`;
  const summary=await z.query(sql);
  const aggregateSql=roles.valueKind==="score"?`WITH ordered AS (SELECT geoid,value,ROW_NUMBER() OVER(PARTITION BY entity_key ORDER BY event_date DESC,record_id) AS rn FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe') SELECT geoid,AVG(value) AS average_inspection_score,COUNT(*) AS establishments_count,SUM(CASE WHEN value<85 THEN 1 ELSE 0 END) AS below_85 FROM ordered WHERE rn=1 AND geoid IS NOT NULL GROUP BY geoid ORDER BY average_inspection_score,geoid`:`SELECT year,month,SUM(value) AS calls_count FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe' GROUP BY year,month ORDER BY year,month`;
  const aggregate=await z.query(aggregateSql,200);
  const proof={term,source:c.title,url:c.url,roles,coverage:wired.coverage,aggregate:{sql:aggregateSql,headers:aggregate.headers,rows:aggregate.rows},source_count:total,placed:result.matched,missing_location:result.invalid,sql,headers:summary.headers,rows:summary.rows,observed_at:new Date().toISOString()};output.push(proof);console.log(JSON.stringify(proof));
  await db.query("UPDATE runs SET finished_at=now() WHERE id=$1",[runId]);
 }
 writeFileSync("evidence/sources/observations-live.json",JSON.stringify(output,null,2)+"\n");
} finally {await db.end();}
