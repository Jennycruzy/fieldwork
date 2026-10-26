import {test,expect}from "vitest";
import {computeFigureLedger}from "../src/figures.js";
import {checkDraft}from "../src/checks.js";
test("figures retain formula and contributing rows for totals, periods, cohorts and comparisons",()=>{
 const h=["year","month","record_count"],rows=[["2026","1","760"],["2026","2","668"],["2026","3","1794"]];
 const fs=computeFigureLedger(h,rows);
 for(const f of fs){expect(f.formula.length).toBeGreaterThan(0);expect(f.rows.every(i=>i>=0&&i<rows.length)).toBe(true);expect(f.labels.length).toBe(f.rows.length);}
 expect(fs.find(f=>f.id==="record_count_total")).toMatchObject({value:3222,rows:[0,1,2]});
 expect(fs.find(f=>f.id==="distinct_month")?.value).toBe(3);
 expect(fs.find(f=>f.id==="record_count_difference_0:1")?.value).toBe(-92);
 expect(checkDraft(["Montgomery recorded 3,222 records from January through March."],h,rows).ok).toBe(true);
 expect(checkDraft(["Montgomery recorded 3,223 records from January through March."],h,rows).ok).toBe(false);
});
test("supporting column and cohort totals have provenance; rates are not summed",()=>{
 const fs=computeFigureLedger(["tract_name","pharmacies_per_10000","pharmacy_count","totalpopulation"],[["Tract 1","0","0","100"],["Tract 2","0","0","200"],["Tract 3","10","1","1000"]]);
 expect(fs.find(f=>f.id==="totalpopulation_total")?.value).toBe(1300);
 expect(fs.find(f=>f.id==="pharmacies_per_10000_zero_totalpopulation_total")).toMatchObject({value:300,rows:[0,1]});
 expect(fs.some(f=>f.id==="pharmacies_per_10000_total")).toBe(false);
});
