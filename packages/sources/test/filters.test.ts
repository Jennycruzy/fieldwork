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
