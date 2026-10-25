
import {test,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {write} from "../src/agents/writer.js";
import {monthlySummarySql} from "../src/agents/joiner.js";
import {checkDraft} from "@fieldwork/core";
import type {Wired} from "../src/agents/wirer.js";
import type {Ctx} from "../src/agents/context.js";
const run=JSON.parse(readFileSync("evidence/runs/r_20261025_aac44f.run.json","utf8"));
test("weighted call metadata sets the monthly unit and always supplies its caveat",async()=>{
 const a=run.answer;
 const wired=[{...a.sources[0],label:"m1_city",where:a.sources[0].filter,zetarisCount:a.sources[0].records,normalized:true,valueKind:"count",valueField:"Call_Count_By_Origin"}] as Wired[];
 const json=vi.fn(async()=>({value:{...structuredClone(a.answer),caveats:[]}}));
 const ctx={models:{writer:{json}},trace:{log:vi.fn()}} as unknown as Ctx;
 const answer=await write(ctx,run.question,a.plan,wired,{sql:a.sql,result:{headers:a.headers,rows:a.rows,total:a.rows.length,ms:0,wallMs:0}},a.checks,run.rounds);
 expect(answer.caveats.some(s=>s.includes("call-center activity")&&s.includes("not confirmed incidents"))).toBe(true);
 const sql=monthlySummarySql(run.id,run.question,a.plan,wired)!;
 expect(sql).toContain("SUM(value) AS call_activity_count");expect(sql).not.toContain("COUNT(*)");
 expect(Number(a.rows[1][2])).toBe(44752);
 const facts=a.checks.map((c:{detail:string})=>c.detail);
 expect(checkDraft(["Montgomery 911 calls were 44,752 in February."],a.headers,a.rows,facts).ok).toBe(true);
 expect(checkDraft(["Montgomery 911 calls were 47,828 in February."],a.headers,a.rows,facts).ok).toBe(false);
});
