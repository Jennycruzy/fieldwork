import { expect, test } from "vitest";
import { withoutCountyLabels } from "../src/agents/wirer.js";

test("county and state name filters are dropped when the county code is applied", () => {
  expect(withoutCountyLabels("stateabbr = 'AL' AND countyname = 'MONTGOMERY'")).toBe("1=1");
  expect(withoutCountyLabels("(countyname = 'MONTGOMERY' AND year = '2025')")).toBe("year = '2025'");
  expect(withoutCountyLabels("countyfips = '01101'")).toBe("1=1");
});

test("other filters, and anything with OR, are left as written", () => {
  expect(withoutCountyLabels("year = '2025'")).toBe("year = '2025'");
  expect(withoutCountyLabels("countyname = 'MONTGOMERY' OR year = '2025'")).toBe(
    "countyname = 'MONTGOMERY' OR year = '2025'",
  );
  expect(withoutCountyLabels("")).toBe("");
  expect(withoutCountyLabels("1=1")).toBe("1=1");
});
