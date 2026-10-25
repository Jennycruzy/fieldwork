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
