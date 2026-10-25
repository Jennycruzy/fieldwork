
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
