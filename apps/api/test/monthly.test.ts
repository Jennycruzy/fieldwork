
import {expect,test} from "vitest";
import {readFileSync} from "node:fs";
import {monthlySummarySql} from "../src/agents/joiner.js";
import type {Wired} from "../src/agents/wirer.js";
test("monthly event totals use the event year, not the source's administrative Year field",()=>{
 const r=JSON.parse(readFileSync("evidence/runs/r_20261024_965af0.run.json","utf8"));
 const ref=JSON.parse(readFileSync("evidence/runs/r_20261024_965af0.reference.json","utf8"));
 const months=ref.observations[0].months as string[][];
 expect(months.some(r=>r[0]==="2025")).toBe(true);
 const sql=monthlySummarySql(r.id,r.question,r.answer.plan,[{label:"m1_city",normalized:true,valueKind:"count"} as Wired])!;
 expect(sql).toContain("year >= 2026 AND year <= 2026");
 expect(sql).toContain("GROUP BY year, month");
 expect(sql).toContain("SUM(value)");
 const total=months.filter(r=>r[0]==="2026").reduce((n,r)=>n+Number(r[3]),0);
 expect(total).toBe(16409);
 expect(r.answer.rows.reduce((n:number,r:string[])=>n+Number(r[1]),0)).toBe(18401);
});
