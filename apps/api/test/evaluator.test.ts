
import {expect,test,vi} from "vitest";
import {readFileSync} from "node:fs";
import {evaluate} from "../src/agents/evaluator.js";
import type {Ctx} from "../src/agents/context.js";
import type {Wired} from "../src/agents/wirer.js";
for(const id of ["624311","f11792"])test(`the model cannot approve recorded unsafe inspection selection ${id}`,async()=>{
 const r=JSON.parse(readFileSync(`evidence/runs/r_20261024_${id}.run.json`,"utf8")),a=r.answer;
 const ctx={cfg:{place:{countyName:"Montgomery",stateAbbr:"AL",stateFips:"01",countyFips:"101"}},today:new Date("2026-10-25"),trace:{log:vi.fn()},models:{evaluator:{json:async()=>({value:{verdict:"APPROVE",reasons:[]}})}}} as unknown as Ctx;
 const wired=a.sources.map((s:{filter:string;records:number;sourceCount:number;label:string;title:string})=>({...s,where:s.filter,zetarisCount:s.records,valueKind:"score"})) as Wired[];
 const ev=await evaluate(ctx,r.question,a.plan,wired,[],{sql:a.sql,result:{headers:a.headers,rows:a.rows,total:a.rows.length,ms:0,wallMs:0}},3);
 expect(ev.verdict.verdict).toBe("REVISE");expect(ev.verdict.target).toBe("wire");
});

import {latestInspectionCheck} from "../src/agents/evaluator.js";
import {inspectionSummarySql} from "../src/agents/joiner.js";
test("a later passing score replaces an older failing score before threshold counting",()=>{
 const a=JSON.parse(readFileSync("evidence/runs/r_20261024_f11792.run.json","utf8")).answer;
 const sql=inspectionSummarySql("r_20261024_f11792","latest inspection score below 85",a.plan,[{normalized:true,valueKind:"score",label:"m1_city"} as Wired])!;
 expect(sql.indexOf("ROW_NUMBER")).toBeLessThan(sql.indexOf("inspection_score < 85"));
 const geo=a.rows[0][3];
 const observations=[[geo,"establishment","2025-01-01","80","a"],[geo,"establishment","2025-02-01","90","b"]];
 const headers=["name","below_threshold_count","total_inspected_establishments","geoid"];
 expect(latestInspectionCheck("latest score below 85",observations,{headers,rows:[["A","0","1",geo]]}).ok).toBe(true);
 expect(latestInspectionCheck("latest score below 85",observations,{headers,rows:[["A","1","1",geo]]}).ok).toBe(false);
});

import {pairedMembershipCheck,categoryTotalsCheck} from "../src/agents/evaluator.js";
test("the actual missing paired tracts cannot be approved as a complete cohort",()=>{
 const a=JSON.parse(readFileSync("evidence/runs/r_20261025_274176.run.json","utf8")).answer;
 const ref=JSON.parse(readFileSync("evidence/runs/r_20261025_274176.reference.json","utf8"));
 const h=ref.health.find((h:{headers:string[]})=>h.headers.includes("bphigh_crudeprev"));
 expect(a.rows).toHaveLength(66);
 expect(pairedMembershipCheck(h.headers,h.rows,a,"residents").ok).toBe(false);
 const geo=h.headers.indexOf("tractfips"),pop=h.headers.indexOf("totalpopulation"),bp=h.headers.indexOf("bphigh_crudeprev");
 const rows=h.rows.filter((r:(string|null)[])=>r[pop]!=null&&Number(r[pop])>0&&r[bp]!=null).map((r:string[])=>[r[geo],"0",r[bp]]);
 expect(pairedMembershipCheck(h.headers,h.rows,{headers:["geoid","count","blood_pressure_prevalence"],rows},"residents").ok).toBe(true);
});
test("200 rows cannot represent the recorded source's 250 request types",()=>{
 const a=JSON.parse(readFileSync("evidence/runs/r_20261025_fa400e.run.json","utf8")).answer;
 const ref=JSON.parse(readFileSync("evidence/runs/r_20261025_fa400e.reference.json","utf8"));
 const categories=ref.observations[0].categories;
 expect(categories).toHaveLength(250);expect(a.rows).toHaveLength(200);
 expect(categoryTotalsCheck(categories,a).ok).toBe(false);
 expect(categoryTotalsCheck(categories,{headers:["category","record_count"],rows:categories}).ok).toBe(true);
});

test("inspection means retain the complete latest cohort with an explicit small-sample flag",()=>{
 const sql=inspectionSummarySql("r_20261026_abcdef","Lowest average latest inspection scores",{in_scope:true,geography:"tract",output:"ranking",measures:[]},[{normalized:true,valueKind:"score",label:"inspections"}as Wired])!;
 expect(sql).toContain("COUNT(*) AS establishment_count");
 expect(sql).toContain("CASE WHEN COUNT(*) < 30 THEN 'small sample' ELSE 'larger sample' END AS sample_note");
 expect(sql).not.toContain("HAVING");
 expect(latestInspectionCheck("Lowest average latest inspection scores",[["a","e","2025-01-01","80","1"]],{headers:["name","average_latest_inspection_score","establishment_count","sample_note","geoid"],rows:[["A","80","1","small sample","a"]]}).ok).toBe(true);
 expect(latestInspectionCheck("Lowest average latest inspection scores",[["a","e","2025-01-01","80","1"]],{headers:["name","average_latest_inspection_score","establishment_count","sample_note","geoid"],rows:[["A","90","1","small sample","a"]]}).ok).toBe(false);
});

import {positiveMembershipCheck} from "../src/agents/evaluator.js";
test("positive membership rejects empty tracts, omissions and duplicate tracts",()=>{
 const source=[["a"],["b"]],headers=["name","service_count","geoid"],rows=[["A","1","a"],["B","2","b"]];
 expect(positiveMembershipCheck(source,{headers,rows}).ok).toBe(true);
 expect(positiveMembershipCheck(source,{headers,rows:[...rows,["C","0","c"]]}).ok).toBe(false);
 expect(positiveMembershipCheck(source,{headers,rows:rows.slice(0,1)}).ok).toBe(false);
 expect(positiveMembershipCheck(source,{headers,rows:[rows[0]!,rows[0]!]}).ok).toBe(false);
});
test("the Evaluator receives disclosure instructions while small samples and accuracy checks stay visible",async()=>{
 const json=vi.fn(async()=>({value:{verdict:"APPROVE",target:null,instruction:null,reasons:["Keep the small-sample warning"]}}));
 const ctx={cfg:{place:{countyName:"Example",stateAbbr:"AL",stateFips:"01",countyFips:"101"}},today:new Date("2026-10-26"),trace:{log:vi.fn()},zetaris:{query:async()=>({rows:[["a","entity","2025-01-01","80","1"]]})},models:{evaluator:{json}}}as unknown as Ctx;
 const p={in_scope:true,geography:"tract"as const,output:"ranking"as const,measures:[],analysis:{basis:"counts"as const,denominator:"none"as const,relationship:false,rank_measure:"lowest average score",reason:"Descriptive establishment averages"}};
 const wired=[{label:"inspections",title:"Inspection Scores",normalized:true,valueKind:"score",where:"1=1",sourceCount:1,zetarisCount:1,excludedTestRecords:0}]as Wired[];
 const ev=await evaluate(ctx,"Lowest average latest inspection scores",p,wired,[],{sql:inspectionSummarySql("r_20261026_abcdef","Lowest average latest inspection scores",p,wired)!,result:{headers:["name","average_latest_inspection_score","establishment_count","sample_note","geoid"],rows:[["A","80","1","small sample","a"]],total:1,ms:0,wallMs:0}},1);
 expect(ev.checks.find(c=>c.id==="sample_size")?.ok).toBe(false);
 expect(ev.checks.find(c=>c.id==="latest_inspection_values")?.ok).toBe(true);
 const prompt=JSON.stringify(json.mock.calls);
 expect(prompt).toContain("Do not replan, rewire or revise SQL solely to add these notes");
 expect(prompt).toContain("Do not invent a minimum group size");
 expect(ev.verdict.verdict).toBe("APPROVE");
});

test("a model approval cannot override an incomplete positive membership list",async()=>{
 const ctx={cfg:{place:{countyName:"Example",stateAbbr:"AL",stateFips:"01",countyFips:"101"}},today:new Date("2026-10-26"),trace:{log:vi.fn()},zetaris:{query:async()=>({rows:[["a"],["b"]]})},models:{evaluator:{json:async()=>({value:{verdict:"APPROVE",reasons:[]}})}}}as unknown as Ctx;
 const p={in_scope:true,geography:"tract"as const,output:"list"as const,measures:[],analysis:{basis:"counts"as const,denominator:"none"as const,relationship:false,rank_measure:"none",reason:"Listed facilities"}};
 const wired=[{label:"services",title:"Listed Services",where:"1=1",sourceCount:3,zetarisCount:3,excludedTestRecords:0}]as Wired[];
 const ev=await evaluate(ctx,"Which areas contain listed facilities?",p,wired,[{label:"services",matched:3,total:3,invalid:0,unmatched:0,duplicates:0,tractsWithRecords:2}],{sql:"SELECT name,count,geoid FROM data",result:{headers:["name","service_count","geoid"],rows:[["A","1","a"]],total:1,ms:0,wallMs:0}},1);
 expect(ev.checks.find(c=>c.id==="positive_membership")?.ok).toBe(false);
 expect(ev.verdict.verdict).toBe("REVISE");expect(ev.verdict.target).toBe("join");
});
