
import {test,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {plan} from "../src/agents/planner.js";
import type {Ctx} from "../src/agents/context.js";
for(const id of ["ee688c","8808f6"])test(`unknown public facilities go to discovery after the recorded refusal ${id}`,async()=>{
 const r=JSON.parse(readFileSync(`evidence/runs/r_20261024_${id}.run.json`,"utf8"));
 const refusal=r.answer.plan;
 const accepted={...refusal,in_scope:true,out_of_scope_reason:null,scope_limit:null,measures:[{id:"m1",describe:r.question,kind:"city_records",search_terms:["pharmacy"]}]};
 const json=vi.fn().mockResolvedValueOnce({value:structuredClone(refusal)}).mockResolvedValueOnce({value:accepted});
 const ctx={cfg:{place:{name:"Montgomery, AL"}},today:new Date("2026-10-25"),models:{planner:{json}}} as unknown as Ctx;
 const result=await plan(ctx,r.question);
 expect(result.in_scope).toBe(true);expect(result.measures[0]?.search_terms).toContain("pharmacy");
 expect(json).toHaveBeenCalledTimes(2);
});
test("explicit public-data scope limits remain refusals",async()=>{
 const value={in_scope:false,scope_limit:"personal",out_of_scope_reason:"Personal diagnosis",geography:"city",measures:[],output:"list"};
 const ctx={cfg:{place:{name:"Montgomery, AL"}},today:new Date(),models:{planner:{json:vi.fn(async()=>({value}))}}} as unknown as Ctx;
 expect((await plan(ctx,"Diagnose my chest pain")).in_scope).toBe(false);
});
