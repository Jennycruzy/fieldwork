import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { analysisChecks, checkDraft } from "../src/index.js";

for (const id of ["217d18", "e05c17"]) {
  test(`recorded relationship ${id} rejects wrong units and unsupported prose`, () => {
    const run = JSON.parse(readFileSync(`evidence/runs/r_20261024_${id}.run.json`, "utf8"));
    const a = run.answer;
    const p = { ...a.plan, analysis: { basis: "rates", denominator: "residents", relationship: true, reason: "Compare population-adjusted burdens", rank_measure: "violation rate descending" } };
    expect(analysisChecks(p, a.sql, a).some((c) => !c.ok)).toBe(true);
    expect(checkDraft([a.answer.headline, ...a.answer.points, a.answer.how_sure], a.headers, a.rows, a.checks.map((c: {detail: string}) => c.detail)).ok).toBe(false);
  });
}
test("how sure cannot claim certainty from correlation", () => {
  expect(checkDraft(["This proves a certain association."], ["tract", "correlation"], [["A", "0.64"]]).ok).toBe(false);
});

test("ranking check inspects values rather than trusting an ORDER BY string",()=>{
 const plan={in_scope:true,geography:"tract" as const,measures:[],output:"ranking" as const,analysis:{basis:"counts" as const,denominator:"none" as const,relationship:false,reason:"Workload",rank_measure:"violations descending"}};
 const check=analysisChecks(plan,"SELECT name, violations FROM counts ORDER BY population DESC",{headers:["name","violations"],rows:[["A","2"],["B","9"]]});
 expect(check.find((c)=>c.id==="ranking_order")?.ok).toBe(false);
});

test("a stated FIPS code is checked as an identifier against the source filter",()=>{
 const rows=[["A","12"]],headers=["name","count"];
 expect(checkDraft(["countyfips=01101"],headers,rows,["countyfips = '01101'"]).ok).toBe(true);
 expect(checkDraft(["countyfips=99999"],headers,rows,["countyfips = '01101'"]).ok).toBe(false);
 expect(checkDraft(["There were 1101 records."],headers,rows,["countyfips = '01101'"]).ok).toBe(false);
});

import {rateArithmeticChecks} from "../src/analysis.js";
test("rates recompute from the recorded population and count, including alternate column labels",()=>{
 const a=JSON.parse(readFileSync("evidence/runs/r_20261024_4fd17e.run.json","utf8")).answer;
 expect(rateArithmeticChecks({headers:a.headers,rows:a.rows}).every(c=>c.ok)).toBe(true);
 const rows=structuredClone(a.rows);rows[0][1]=String(Number(rows[0][1])*1000);
 expect(rateArithmeticChecks({headers:a.headers,rows}).some(c=>!c.ok)).toBe(true);
 const bad=JSON.parse(readFileSync("evidence/runs/r_20261024_ee364c.run.json","utf8")).answer;
 expect(rateArithmeticChecks(bad).some(c=>!c.ok)).toBe(true);
});
