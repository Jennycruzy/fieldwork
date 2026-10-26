import type {Plan} from "@fieldwork/core";
import type {Wired} from "./wirer.js";
// These templates operate on schema/plan shapes, never question IDs or a source inventory.
// They still go through Zetaris, the independent code checks and every Evaluator round.
export function tractSummarySql(runId:string,question:string,p:Plan,wired:Wired[],bridged:string[]):string|undefined{
 if(p.geography!=="tract"||!p.analysis)return;
 if(!wired.length||wired.some(w=>w.capped))return;
 const counts=wired.filter(w=>bridged.includes(w.label));
 const health=wired.filter(w=>w.shape==="socrata_list"&&w.fields.includes("tractfips"));
 if(counts.length===2&&health.length===1&&wired.length===3&&p.analysis.relationship)return pairedCountRatesSql(runId,p,counts,health[0]!);
 if(counts.length>1||health.length>1||wired.length!==counts.length+health.length)return;
 const city=counts[0],cdc=health[0];
 const identifier=(s:string)=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
 const safe=(!city||identifier(city.label))&&(!cdc||cdc.tables.length===1&&identifier(cdc.tables[0]!)&&cdc.fields.every(identifier));
 if(!safe||!/^r_\d{8}_[0-9a-f]{6}$/.test(runId))return;
 const field=cdc?.fields.filter(f=>/_crudeprev$/i.test(f));
 const healthField=field?.length===1?field[0]:undefined;
 const healthAlias=healthField?.replace(/_crudeprev$/i,"_prevalence");
 const denominator=p.analysis.denominator==="adults"?"totalpop18plus":"totalpopulation";
 const needsRate=!!city&&(p.analysis.basis==="rates"||p.analysis.relationship);
 if(needsRate&&(!city||!cdc||!cdc.fields.includes(denominator)))return;
 if(p.analysis.relationship&&(!city||!cdc||!healthField))return;
 if(!p.analysis.relationship&&!["ranking","list"].includes(p.output)&&!(p.output==="comparison"&&p.years?.from&&p.years.to&&p.years.from!==p.years.to&&/increas|decreas|change|difference/i.test(p.analysis.rank_measure)))return;
 if(cdc&&!needsRate&&!healthField)return;
 if(city&&!cdc&&!p.analysis.relationship&&p.years?.from&&p.years?.to&&p.years.from!==p.years.to&&/increas|decreas|change|difference/i.test(p.analysis.rank_measure)){
  if(!city.normalized||city.valueKind!=="count")return;
  const a=p.years.from,b=p.years.to;
  const totals="SELECT geoid,SUM(CASE WHEN year="+a+" THEN value ELSE 0 END) AS earlier_count,SUM(CASE WHEN year="+b+" THEN value ELSE 0 END) AS later_count FROM fw_pg.tract_observations WHERE run_id='"+runId+"' AND source='"+city.label+"' AND geoid IS NOT NULL GROUP BY geoid";
  const ascending=/lowest|fewest|smallest|ascending/i.test(p.analysis.rank_measure);
  return "WITH totals AS ("+totals+") SELECT t.name AS tract_name,COALESCE(n.later_count,0)-COALESCE(n.earlier_count,0) AS count_change,COALESCE(n.earlier_count,0) AS count_"+a+",COALESCE(n.later_count,0) AS count_"+b+",t.geoid FROM fw_pg.tracts t LEFT JOIN totals n ON t.geoid=n.geoid ORDER BY count_change "+(ascending?"ASC":"DESC")+",tract_name";
 }
 const countAlias=countColumn(city?.title??"");
 const scale=/\bper\s+10,?000\b/i.test(question)?10000:1000;
 const rateAlias=countAlias+"_per_"+scale+"_"+denominator;
 const asc=/lowest|fewest|smallest|ascending/i.test(p.analysis.rank_measure);
 const metric=needsRate?rateAlias:healthField?healthAlias!:countAlias;
 const columns:string[]=["t.name AS tract_name"];
 if(needsRate)columns.push("COALESCE(n.n,0) * "+scale+".0 / NULLIF(CAST(h."+denominator+" AS DOUBLE),0) AS "+rateAlias);
 else if(healthField)columns.push("CAST(h."+healthField+" AS DOUBLE) AS "+healthAlias);
 else if(city)columns.push("COALESCE(n.n,0) AS "+countAlias);
 else return;
 if(city&&(needsRate||healthField))columns.push("COALESCE(n.n,0) AS "+countAlias);
 if(cdc&&cdc.fields.includes(denominator))columns.push("CAST(h."+denominator+" AS DOUBLE) AS "+denominator);
 if(healthField&&needsRate)columns.push("CAST(h."+healthField+" AS DOUBLE) AS "+healthAlias);
 columns.push("t.geoid");
 let from=" FROM fw_pg.tracts t";
 if(city)from+=" LEFT JOIN fw_pg.tract_counts n ON n.geoid=t.geoid AND n.run_id='"+runId+"' AND n.source='"+city.label+"' AND n.grp='all'";
 if(cdc)from+=" LEFT JOIN session."+cdc.tables[0]+" h ON h.tractfips=t.geoid";
 const where:string[]=[];
 if(p.analysis.relationship){
  where.push("CAST(h."+denominator+" AS DOUBLE)>0","h."+healthField+" IS NOT NULL");
 }else if(city&&!cdc&&/\b(no|zero|without)\b/i.test(question))where.push("COALESCE(n.n,0)=0");
 else if(city&&!cdc&&p.output==="list")where.push("COALESCE(n.n,0)>0");
 const base="SELECT "+columns.join(",")+from+(where.length?" WHERE "+where.join(" AND "):"");
 const order=" ORDER BY "+metric+(asc?" ASC":" DESC")+" NULLS LAST,tract_name";
 if(!p.analysis.relationship)return base+order;
 const projection=["tract_name",rateAlias,countAlias,denominator,healthAlias!,"CORR("+rateAlias+","+healthAlias+") OVER () AS rate_prevalence_correlation","COUNT(*) OVER () AS paired_tracts","geoid"];
 return "WITH paired AS ("+base+") SELECT "+projection.join(",")+" FROM paired"+order;
}

function pairedCountRatesSql(runId:string,p:Plan,counts:Wired[],health:Wired):string|undefined{
 const safe=(s:string)=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
 if(!/^r_\d{8}_[0-9a-f]{6}$/.test(runId)||counts.some(w=>!safe(w.label))||health.tables.length!==1||!safe(health.tables[0]!))return;
 const population=p.analysis?.denominator==="adults"?"totalpop18plus":"totalpopulation";
 if(!health.fields.includes(population))return;
 const aliases=counts.map(w=>countColumn(w.title));
 if(aliases.some(a=>!safe(a))||new Set(aliases).size!==2)return;
 const rates=aliases.map(a=>a+"_per_1000_"+population);
 const totals="SELECT geoid,"+counts.map((w,i)=>"SUM(CASE WHEN source='"+w.label+"' THEN n ELSE 0 END) AS c"+i).join(",")+" FROM fw_pg.tract_counts WHERE run_id='"+runId+"' AND grp='all' AND source IN ("+counts.map(w=>"'"+w.label+"'").join(",")+") GROUP BY geoid";
 const selected=["t.name AS tract_name",...rates.map((r,i)=>"COALESCE(n.c"+i+",0)*1000.0/NULLIF(CAST(h."+population+" AS DOUBLE),0) AS "+r),...aliases.map((a,i)=>"COALESCE(n.c"+i+",0) AS "+a),"CAST(h."+population+" AS DOUBLE) AS "+population,"t.geoid"];
 const paired="SELECT "+selected.join(",")+" FROM fw_pg.tracts t LEFT JOIN totals n ON n.geoid=t.geoid LEFT JOIN session."+health.tables[0]+" h ON h.tractfips=t.geoid WHERE CAST(h."+population+" AS DOUBLE)>0";
 return "WITH totals AS ("+totals+"), paired AS ("+paired+") SELECT tract_name,"+[...rates,...aliases,population,"CORR("+rates.join(",")+") OVER () AS rate_correlation","COUNT(*) OVER () AS paired_tracts","geoid"].join(",")+" FROM paired ORDER BY "+rates[0]+" DESC NULLS LAST,tract_name";
}

function countColumn(title:string):string{
 const name=title.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
 return name?(/^[a-z]/.test(name)?name:"source_"+name)+"_count":"source_record_count";
}
