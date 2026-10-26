import{test,expect,vi}from"vitest";
import{tractSummarySql}from"../src/agents/queryTemplates.js";
import{join}from"../src/agents/joiner.js";
import{analysisChecks}from"@fieldwork/core";
import type{Plan}from"@fieldwork/core";
import type{Wired}from"../src/agents/wirer.js";
import type{Ctx}from"../src/agents/context.js";
import{HMEM}from"@fieldwork/hmem";
const id="r_20261026_abcdef";
const city={title:"Public Events",label:"m1_city",shape:"arcgis_features",fields:[],tables:["source"],capped:false}as unknown as Wired;
const health={title:"Public Estimates",label:"m2_cdc",shape:"socrata_list",fields:["tractfips","totalpopulation","totalpop18plus","condition_crudeprev"],tables:["fw_abcdef_m2_cdc"],capped:false}as unknown as Wired;
const plan:Plan={in_scope:true,geography:"tract",output:"ranking",measures:[],analysis:{basis:"counts",denominator:"none",relationship:false,rank_measure:"event count descending",reason:"Workload"}};
test("a schema-driven count ranking retains measure second, geography last and all tracts",()=>{
 const sql=tractSummarySql(id,"Which areas have most events?",plan,[city],["m1_city"])!;
 expect(sql).toContain("SELECT t.name AS tract_name,COALESCE(n.n,0) AS public_events_count,t.geoid");
 expect(sql).toContain("LEFT JOIN fw_pg.tract_counts");expect(sql).toContain("n.grp='all'");expect(sql).toContain("DESC NULLS LAST");
 expect(sql).not.toContain("LIMIT");
});
test("rate templates retain count, matching denominator and requested scaling, including zero denominators",()=>{
 const p={...plan,analysis:{...plan.analysis!,basis:"rates"as const,denominator:"residents"as const,rank_measure:"fewest events per 10000"}};
 const sql=tractSummarySql(id,"Events per 10,000 residents",p,[city,health],["m1_city"])!;
 expect(sql).toContain("10000.0 / NULLIF(CAST(h.totalpopulation AS DOUBLE),0)");
 expect(sql).toContain("COALESCE(n.n,0) AS public_events_count");expect(sql).toContain(" ASC NULLS LAST");
 expect(tractSummarySql(id,"Events per 1,000 residents",p,[city,{...health,fields:["tractfips"]}],["m1_city"])).toBeUndefined();
});
test("health rankings place prevalence before supporting counts without introducing a correlation",()=>{
 const p={...plan,analysis:{...plan.analysis!,basis:"mixed"as const,denominator:"adults"as const}};
 const sql=tractSummarySql(id,"Highest condition prevalence and event counts",p,[city,health],["m1_city"])!;
 expect(sql).toContain("tract_name,CAST(h.condition_crudeprev AS DOUBLE) AS condition_prevalence,COALESCE(n.n,0)");
 expect(sql).not.toContain("CORR(");
});
test("relationships compute correlation and full paired size over eligible resident rates",()=>{
 const p={...plan,output:"comparison"as const,analysis:{...plan.analysis!,basis:"rates"as const,denominator:"residents"as const,relationship:true}};
 const sql=tractSummarySql(id,"Are events associated with condition prevalence?",p,[city,health],["m1_city"])!;
 expect(sql).toContain("WITH paired AS");expect(sql).toContain("CAST(h.totalpopulation AS DOUBLE)>0");
 expect(sql).toContain("h.condition_crudeprev IS NOT NULL");expect(sql).toContain("CORR(public_events_count_per_1000_totalpopulation,condition_prevalence) OVER ()");
 expect(sql).toContain("COUNT(*) OVER () AS paired_tracts");expect(sql).not.toContain("LIMIT");
});
test("zero-list membership uses a left join and actual source counts",()=>{
 const p={...plan,output:"list"as const};
 expect(tractSummarySql(id,"Which areas have no listed services?",p,[city],["m1_city"])).toContain("WHERE COALESCE(n.n,0)=0");
});
test("unsupported or ambiguous schema shapes still use model-generated SQL",()=>{
 expect(tractSummarySql(id,"Events",plan,[city,{...city,label:"m2_city"}],["m1_city","m2_city"])).toBeUndefined();
 expect(tractSummarySql(id,"Estimates",plan,[{...health,fields:[...health.fields,"other_crudeprev"]}],[])).toBeUndefined();
 expect(tractSummarySql(id,"Events",plan,[{...city,capped:true}],["m1_city"])).toBeUndefined();
});
test("template queries run through Zetaris and retain the ranking code check",async()=>{
 const query=vi.fn(async()=>({headers:["tract_name","public_events_count","geoid"],rows:[["A","8","a"],["B","2","b"]],total:2,ms:1,wallMs:1}));
 const json=vi.fn();const ctx={runId:id,runShort:"abcdef",cfg:{place:{countyName:"Example"}},memory:new HMEM(),recalled:[],models:{joiner:{json}},zetaris:{query},trace:{log:vi.fn()}}as unknown as Ctx;
 const result=await join(ctx,"Which areas have most events?",plan,[city],["m1_city"]);
 expect(json).not.toHaveBeenCalled();expect(query).toHaveBeenCalledTimes(1);
 expect(analysisChecks(plan,result.sql,result.result).find(c=>c.id==="ranking_order")?.ok).toBe(true);
 expect(analysisChecks(plan,result.sql,{...result.result,rows:[...result.result.rows].reverse()}).find(c=>c.id==="ranking_order")?.ok).toBe(false);
});
test("two-source rate relationships use one counts-table scan and the full paired population",()=>{
 const other={...city,title:"Service Requests",label:"m3_city"};
 const p={...plan,output:"comparison"as const,analysis:{...plan.analysis!,basis:"rates"as const,denominator:"residents"as const,relationship:true}};
 const sql=tractSummarySql(id,"Are event rates related to request rates?",p,[city,other,health],["m1_city","m3_city"])!;
 expect(sql.match(/FROM fw_pg\.tract_counts/g)).toHaveLength(1);
 expect(sql).toContain("source='m1_city'");expect(sql).toContain("source='m3_city'");
 expect(sql).toContain("CORR(public_events_count_per_1000_totalpopulation,service_requests_count_per_1000_totalpopulation) OVER ()");
 expect(sql).toContain("COUNT(*) OVER () AS paired_tracts");
 expect(sql).not.toContain("LIMIT");
});
test("year-change rankings keep both source periods and sort the arithmetic difference",()=>{
 const p={...plan,years:{from:2024,to:2025},analysis:{...plan.analysis!,rank_measure:"biggest increase in event counts"}};
 const sql=tractSummarySql(id,"Which areas had the biggest increase?",p,[{...city,normalized:true,valueKind:"count"}],["m1_city"])!;
 expect(sql).toContain("year=2024 THEN value");expect(sql).toContain("year=2025 THEN value");
 expect(sql).toContain("AS count_2024");expect(sql).toContain("AS count_2025");expect(sql).toContain("ORDER BY count_change DESC");
 expect(tractSummarySql(id,"Which areas had the biggest increase?",p,[city],["m1_city"])).toBeUndefined();
});
test("a published health prevalence is retained directly rather than dividing it again",()=>{
 const p={...plan,analysis:{...plan.analysis!,basis:"rates"as const,denominator:"adults"as const}};
 const sql=tractSummarySql(id,"Which areas have highest estimated condition prevalence?",p,[health],[])!;
 expect(sql).toContain("CAST(h.condition_crudeprev AS DOUBLE) AS condition_prevalence");
 expect(sql).not.toContain("NULLIF");expect(sql).not.toContain("tract_counts");
});
test("source titles beginning with numbers get valid descriptive SQL identifiers",()=>{
 const service={...city,title:"311 Service Requests",label:"service_city"};
 const count=tractSummarySql(id,"Which areas have most requests?",plan,[service],["service_city"])!;
 expect(count).toContain("AS source_311_service_requests_count");
 const p={...plan,output:"comparison"as const,analysis:{...plan.analysis!,basis:"rates"as const,denominator:"residents"as const,relationship:true}};
 expect(tractSummarySql(id,"Compare two service rates",p,[city,service,health],["m1_city","service_city"])).toContain("source_311_service_requests_count_per_1000_totalpopulation");
});

test("a revision bypasses every compiled template and executes the requested model repair",async()=>{
 const scenarios=[
  {question:"Which areas contain listed services?",p:{...plan,output:"list"as const},wired:[city],bridged:["m1_city"],sql:"SELECT name,1 AS count,geoid FROM fw_pg.tracts WHERE geoid='a'",instruction:"Return only positive membership"},
  {question:"Lowest average latest inspection scores",p:plan,wired:[{...city,normalized:true,valueKind:"score"}as Wired],bridged:[],sql:"SELECT name,80 AS average_score,2 AS establishment_count,geoid FROM fw_pg.tracts",instruction:"Flag small groups"},
  {question:"Monthly events",p:{...plan,geography:"city"as const,output:"trend"as const},wired:[{...city,normalized:true,valueKind:"count"}as Wired],bridged:[],sql:"SELECT 2025 AS year,1 AS month,2 AS record_count",instruction:"Repair monthly date grouping"},
  {question:"Types of requests",p:{...plan,geography:"city"as const},wired:[{...city,groupField:"kind",normalized:true,valueKind:"count"}as Wired],bridged:[],sql:"SELECT 'Unknown' AS category,2 AS record_count",instruction:"Retain missing categories"}
 ];
 for(const scenario of scenarios){
  const query=vi.fn(async()=>({headers:["name","count","geoid"],rows:[["A","1","a"]],total:1,ms:1,wallMs:1}));
  const json=vi.fn(async()=>({value:{sql:scenario.sql,explain:"Repaired"}}));
  const ctx={runId:id,runShort:"abcdef",cfg:{place:{countyName:"Example"}},memory:new HMEM(),recalled:[],models:{joiner:{json}},zetaris:{query},trace:{log:vi.fn()}}as unknown as Ctx;
  const result=await join(ctx,scenario.question,scenario.p,scenario.wired,scenario.bridged,scenario.instruction,"SELECT 0");
  expect(json).toHaveBeenCalledTimes(1);expect(JSON.stringify(json.mock.calls)).toContain(scenario.instruction);
  expect(result.sql).toBe(scenario.sql);expect(query).toHaveBeenCalledWith(scenario.sql,expect.any(Number));
 }
});
