import { expect, test } from "vitest";
import { yearAsDateRange } from "../src/filters.js";

const fields = [
  { name: "Year", type: "string" },
  { name: "CaseDate", type: "date" },
  { name: "CaseType", type: "string" },
];
const y2025 = "(CaseDate >= TIMESTAMP '2025-01-01 00:00:00' AND CaseDate < TIMESTAMP '2026-01-01 00:00:00')";

test("a requested calendar year filters on each record's own date, not the publisher's Year label", () => {
  expect(yearAsDateRange("Year = '2025'", fields, "Year", "CaseDate")).toBe(y2025);
  expect(yearAsDateRange("Year=2025", fields, "Year", "CaseDate")).toBe(y2025);
  expect(yearAsDateRange("(Year = '2025') AND (CaseType = 'Nuisance')", fields, "Year", "CaseDate")).toBe(
    `(${y2025}) AND (CaseType = 'Nuisance')`,
  );
});

test("year lists, ranges and bounds become date ranges", () => {
  expect(yearAsDateRange("Year IN ('2024','2025')", fields, "Year", "CaseDate")).toBe(
    "(CaseDate >= TIMESTAMP '2024-01-01 00:00:00' AND CaseDate < TIMESTAMP '2026-01-01 00:00:00')",
  );
  expect(yearAsDateRange("Year IN (2021, 2025)", fields, "Year", "CaseDate")).toBe(
    "((CaseDate >= TIMESTAMP '2021-01-01 00:00:00' AND CaseDate < TIMESTAMP '2022-01-01 00:00:00') OR " +
      y2025 +
      ")",
  );
  expect(yearAsDateRange("Year BETWEEN '2023' AND '2025'", fields, "Year", "CaseDate")).toBe(
    "(CaseDate >= TIMESTAMP '2023-01-01 00:00:00' AND CaseDate < TIMESTAMP '2026-01-01 00:00:00')",
  );
  expect(yearAsDateRange("Year >= '2024'", fields, "Year", "CaseDate")).toBe(
    "CaseDate >= TIMESTAMP '2024-01-01 00:00:00'",
  );
  expect(yearAsDateRange("Year > 2024", fields, "Year", "CaseDate")).toBe(
    "CaseDate >= TIMESTAMP '2025-01-01 00:00:00'",
  );
  expect(yearAsDateRange("Year <= 2025", fields, "Year", "CaseDate")).toBe(
    "CaseDate < TIMESTAMP '2026-01-01 00:00:00'",
  );
  expect(yearAsDateRange("Year < '2025'", fields, "Year", "CaseDate")).toBe(
    "CaseDate < TIMESTAMP '2025-01-01 00:00:00'",
  );
});

test("fiscal-year requests, missing dates and quoted values keep their meaning", () => {
  expect(yearAsDateRange("Year = '2025'", fields, "Year", "CaseDate", "311 requests in fiscal 2025")).toBe(
    "Year = '2025'",
  );
  expect(yearAsDateRange("Year = '2025'", fields, "Year", "CaseDate", "requests in FY2025")).toBe(
    "Year = '2025'",
  );
  expect(yearAsDateRange("Year = '2025'", fields, "Year", undefined)).toBe("Year = '2025'");
  expect(
    yearAsDateRange(
      "Year = '2025'",
      [
        { name: "Year", type: "string" },
        { name: "CaseDate", type: "string" },
      ],
      "Year",
      "CaseDate",
    ),
  ).toBe("Year = '2025'");
  expect(yearAsDateRange("CaseType = 'Year = 2025 review' AND Year = 2025", fields, "Year", "CaseDate")).toBe(
    `CaseType = 'Year = 2025 review' AND ${y2025}`,
  );
  expect(yearAsDateRange("CaseType = 'Nuisance'", fields, "Year", "CaseDate")).toBe("CaseType = 'Nuisance'");
  expect(
    yearAsDateRange(
      "FiscalYear = 2025",
      [...fields, { name: "FiscalYear", type: "integer" }],
      "Year",
      "CaseDate",
    ),
  ).toBe("FiscalYear = 2025");
});
