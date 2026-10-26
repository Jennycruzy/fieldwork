import { test, expect } from "vitest";
import { computeFigureLedger } from "../src/figures.js";
import { checkDraft } from "../src/checks.js";
test("figures retain formula and contributing rows for totals, periods, cohorts and comparisons", () => {
  const h = ["year", "month", "record_count"],
    rows = [
      ["2026", "1", "760"],
      ["2026", "2", "668"],
      ["2026", "3", "1794"],
    ];
  const fs = computeFigureLedger(h, rows);
  for (const f of fs) {
    expect(f.formula.length).toBeGreaterThan(0);
    expect(f.rows.every((i) => i >= 0 && i < rows.length)).toBe(true);
    expect(f.labels.length).toBe(f.rows.length);
  }
  expect(fs.find((f) => f.id === "record_count_total")).toMatchObject({ value: 3222, rows: [0, 1, 2] });
  expect(fs.find((f) => f.id === "distinct_month")?.value).toBe(3);
  expect(fs.find((f) => f.id === "record_count_difference_0:1")?.value).toBe(-92);
  expect(checkDraft(["Montgomery recorded 3,222 records from January through March."], h, rows).ok).toBe(
    true,
  );
  expect(checkDraft(["Montgomery recorded 3,223 records from January through March."], h, rows).ok).toBe(
    false,
  );
});
test("supporting column and cohort totals have provenance; rates are not summed", () => {
  const fs = computeFigureLedger(
    ["tract_name", "pharmacies_per_10000", "pharmacy_count", "totalpopulation"],
    [
      ["Tract 1", "0", "0", "100"],
      ["Tract 2", "0", "0", "200"],
      ["Tract 3", "10", "1", "1000"],
    ],
  );
  expect(fs.find((f) => f.id === "totalpopulation_total")?.value).toBe(1300);
  expect(fs.find((f) => f.id === "pharmacies_per_10000_zero_totalpopulation_total")).toMatchObject({
    value: 300,
    rows: [0, 1],
  });
  expect(fs.some((f) => f.id === "pharmacies_per_10000_total")).toBe(false);
});
import { figureLedgerForTexts } from "../src/checks.js";
test("a quoted comparison between arbitrary named rows keeps both source rows and its formula", () => {
  const rows = [
    ["Tract 1", "80"],
    ["Tract 2", "70"],
    ["Tract 3", "60"],
    ["Tract 4", "30"],
    ["Tract 5", "20"],
  ];
  const fs = figureLedgerForTexts(["tract_name", "record_count"], rows, [
    "Tract 2 had 40 more records than Tract 4.",
  ]);
  expect(fs.find((f) => f.id === "record_count_difference_3:1")).toMatchObject({
    value: 40,
    rows: [3, 1],
    labels: ["Tract 4", "Tract 2"],
  });
  const periods = computeFigureLedger(
    ["year", "month", "record_count"],
    [
      ["2025", "1", "10"],
      ["2026", "1", "20"],
    ],
  );
  expect(periods.find((f) => f.id === "distinct_periods")?.value).toBe(2);
  expect(periods.find((f) => f.id === "distinct_month")?.value).toBe(1);
});
test("a named subset total retains the exact contributing rows", () => {
  const fs = figureLedgerForTexts(
    ["tract_name", "record_count"],
    [
      ["Tract 1", "80"],
      ["Tract 2", "70"],
      ["Tract 3", "60"],
      ["Tract 4", "30"],
      ["Tract 5", "20"],
    ],
    ["The total for Tract 2 and Tract 4 is 100 records."],
  );
  expect(fs.find((f) => f.id === "record_count_named_total_1_3")).toMatchObject({ value: 100, rows: [1, 3] });
});
