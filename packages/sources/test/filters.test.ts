import {expect,test} from "vitest";
import {withoutPostalFilters} from "../src/filters.js";
test("unasked postal labels cannot drop records before spatial membership",()=>{
 expect(withoutPostalFilters("Year = '2025' AND City = 'Montgomery'")).toBe("Year = '2025'");
 expect(withoutPostalFilters("(City = 'Montgomery') AND (Year = '2025')")).toBe("(Year = '2025')");
 expect(withoutPostalFilters("((City = 'Montgomery' AND Year = '2025') AND STATE = 'AL')")).toBe("((Year = '2025'))");
});
test("source conditions and quoted conjunctions keep their meaning",()=>{
 expect(withoutPostalFilters("Type='Research AND Development' AND Year='2025'")).toBe("Type='Research AND Development' AND Year='2025'");
 expect(withoutPostalFilters("(Status IS NULL OR Status <> 'DEBUG_TEST') AND Year='2025'")).toBe("(Status IS NULL OR Status <> 'DEBUG_TEST') AND Year='2025'");
 expect(withoutPostalFilters("City='Montgomery' OR Year='2025'")).toBe("City='Montgomery' OR Year='2025'");
});

import {readFileSync} from "node:fs";
import {typedWhere} from "../src/filters.js";
test("311 integer Year metadata is respected for grouped citywide requests",()=>{
 const fixture=JSON.parse(readFileSync("evidence/sources/live-probes.json","utf8"))[0];
 expect(typedWhere("Year = '2025'",fixture.fields)).toBe("Year = 2025");
 expect(typedWhere("Year = '2025' AND Request_Type = '2025'",fixture.fields)).toBe("Year = 2025 AND Request_Type = '2025'");
 expect(typedWhere("Year = '2025'",[{name:"Year",type:"string"}])).toBe("Year = '2025'");
});

import {inspectionSourceWhere} from "../src/filters.js";
test("the recorded inspection filters cannot discard the latest or all rows",()=>{
 const mean=JSON.parse(readFileSync("evidence/runs/r_20261024_624311.run.json","utf8"));
 const threshold=JSON.parse(readFileSync("evidence/runs/r_20261024_f11792.run.json","utf8"));
 expect(inspectionSourceWhere(mean.answer.sources[0].filter,mean.question)).toBe("1=1");
 expect(inspectionSourceWhere(threshold.answer.sources[0].filter,threshold.question)).toBe("1=1");
 expect(inspectionSourceWhere("Year=2025 AND Score_1 < 85","latest inspections")).toBe("Year=2025 AND 1=1");
 expect(inspectionSourceWhere("Status = 'Closed'","latest inspections of closed establishments")).toBe("Status = 'Closed'");
});
