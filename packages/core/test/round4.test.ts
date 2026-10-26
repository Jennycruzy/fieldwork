import {test,expect} from "vitest";
import {checkDraft} from "../src/checks.js";
const h=["tract_name","request_count","geoid"];
test("parenthesized and slash tract lists preserve identifiers and check their values",()=>{
 const rows=[["Census Tract 55.02","0","a"],["Census Tract 55.04","0","b"],["Census Tract 57","0","c"]];
 expect(checkDraft(["Three tracts (55.02, 55.04, 57) each had 0 requests."],h,rows).ok).toBe(true);
 expect(checkDraft(["Three tracts (55.02, 55.04, 57) each had 8 requests."],h,rows).ok).toBe(false);
 expect(checkDraft(["Tracts 55.02/55.04 share rank 1."],h,rows).ok).toBe(true);
 expect(checkDraft(["Tracts 55.02/55.04 share rank 2."],h,rows).ok).toBe(false);
});
test("comparison binds the second rank to the comparison row and verifies arithmetic",()=>{
 const rows=[["Census Tract 1","1419","a"],["Census Tract 25","1071","b"]];
 expect(checkDraft(["Census Tract 1 led with 1,419 requests, 348 more than the second-ranked Tract 25."],h,rows).ok).toBe(true);
 expect(checkDraft(["Census Tract 1 led with 1,419 requests, 141 more than the second-ranked Tract 25."],h,rows).ok).toBe(false);
 expect(checkDraft(["Census Tract 1 led with 1,419 requests, 348 more than the first-ranked Tract 25."],h,rows).ok).toBe(false);
});
test("percent of an extreme gap is arithmetic rather than a rank on another column",()=>{
 const rows=[["Census Tract 1","14","818"],["Census Tract 2","8.3","22"]];
 const headers=["tract_name","asthma_rate","violation_count"];
 expect(checkDraft(["The highest rate is 68.7% above the lowest rate."],headers,rows).ok).toBe(true);
 expect(checkDraft(["The highest rate is 88.7% above the lowest rate."],headers,rows).ok).toBe(false);
});
test("verified filter thresholds are not row rankings and wrong thresholds fail",()=>{
 const headers=["name","average_score","establishment_count"],rows=[["Census Tract 1","88","3"],["Census Tract 2","92","4"]];
 expect(checkDraft(["Tracts with fewer than 2 establishments were excluded from the lowest-score ranking."],headers,rows,["Filter: fewer than 2 establishments excluded"]).ok).toBe(true);
 expect(checkDraft(["Tracts with fewer than 4 establishments were excluded from the lowest-score ranking."],headers,rows,["Filter: fewer than 2 establishments excluded"]).ok).toBe(false);
 expect(checkDraft(["Census Tract 2 has the lowest score at 92."],headers,rows).ok).toBe(false);
});
test("zero cohort tie size and rank must both match",()=>{
 const headers=["tract_name","pharmacies_per_10000","pharmacy_count"],rows=[["Census Tract 1","0","0"],["Census Tract 2","0","0"],["Census Tract 3","2","1"]];
 expect(checkDraft(["All 2 zero-pharmacy tracts are ranked 1st together in ascending order."],headers,rows).ok).toBe(true);
 expect(checkDraft(["All 3 zero-pharmacy tracts are ranked 1st together in ascending order."],headers,rows).ok).toBe(false);
 expect(checkDraft(["All 2 zero-pharmacy tracts are ranked 2nd together in ascending order."],headers,rows).ok).toBe(false);
});
import {runChecks}from "../src/checks.js";
test("the current month is code-labelled and cannot receive a comparative rank",()=>{
 const h=["year","month","record_count"],rows=[["2026","9","100"],["2026","10","1"]];
 const facts=runChecks({sourceCounts:[],resultRows:2,result:{headers:h,rows},today:new Date("2026-10-26")}).map(c=>c.detail);
 expect(facts.some(f=>f.startsWith("Partial month: October 2026"))).toBe(true);
 expect(checkDraft(["October 2026 has the lowest count at 1."],h,rows,facts).ok).toBe(false);
 expect(checkDraft(["October 2026 has 1 record so far."],h,rows,facts).ok).toBe(true);
});
import {finalizeDraft}from "../src/checks.js";
test("sentence filtering keeps verified points and rebuilds an invalid headline from rows",()=>{
 const h=["tract_name","shelter_count"],rows=[["Census Tract 22.01","1"],["Census Tract 4","0"]];
 const result=finalizeDraft({headline:"Tract 22.01 has 4 shelters.",points:["Tract 22.01 has 1 shelter. Tract 22.01 has 8 shelters."],how_sure:"These are listed shelters.",caveats:[]},h,rows,[]);
 expect(result.removed).toEqual(["Tract 22.01 has 4 shelters.","Tract 22.01 has 8 shelters."]);
 expect(result.draft.points).toEqual(["Tract 22.01 has 1 shelter."]);
 expect(checkDraft([result.draft.headline,...result.draft.points,result.draft.how_sure],h,rows).ok).toBe(true);
});
test("an unproven share of an extreme gap is rejected without inventing a row ranking",()=>{
 const result=checkDraft(["The top five tracts by asthma rate account for 68.7% of the gap between the highest and lowest rates."],["tract_name","asthma_rate","violation_count"],[["Census Tract 1","14","818"],["Census Tract 2","8.3","22"]]);
 expect(result.ok).toBe(false);expect(result.orderProblems.some(s=>s.includes("no supplied formula"))).toBe(true);
 expect(result.orderProblems.some(s=>s.includes("violation_count"))).toBe(false);
});
import{readFileSync}from"node:fs";
test("calendar totals and exact named-period changes accept real arithmetic and reject wrong arithmetic",()=>{
 const a=JSON.parse(readFileSync("evidence/runs/r_20261026_180eb2.run.json","utf8")).answer;
 expect(checkDraft(["June 2026 had the highest count at 2,521, 277.4% above the February 2026 low of 668"],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["June 2026 had the highest count at 2,521, 279.4% above the February 2026 low of 668"],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["October 2026 count (694) is 66 fewer than January 2026 (760), an 8.7% decrease"],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["October 2026 count (694) is 66 fewer than January 2026 (760), a 9.7% decrease"],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["Data covers 10 of 12 calendar months."],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Data covers 10 of 13 calendar months."],a.headers,a.rows).ok).toBe(false);
});
