import { expect, test } from "vitest";
import { applyCoverageCaveats } from "../src/agents/writer.js";
import { expectedMonths } from "../src/agents/evaluator.js";

const today = new Date("2026-10-27T00:00:00Z");
const incomplete = {
  id: "source_dates_m1_city",
  ok: true,
  detail:
    "Code Violations: event dates 2025-01-02 to 2025-12-31; monthly coverage 2025-01 through 2025-12 (11 distinct months). Only 11 calendar months contain records; 1 month has no source rows. Complete annual coverage is not established; absent months are not confirmed zeros.",
};

test("a false complete-coverage claim is removed and the coverage note is stated", () => {
  const value = applyCoverageCaveats(
    {
      headline: "Tract 12 led.",
      points: ["Tract 12 led with 818 violations."],
      how_sure:
        "The ranking uses 71 tracts. Code violations data comes from city records with complete annual 2025 coverage. Population is Census 2020.",
      caveats: ["Population is Census 2020."],
    },
    [incomplete],
  );
  expect(value.how_sure).toBe("The ranking uses 71 tracts. Population is Census 2020.");
  expect(value.caveats.at(-1)).toMatch(/^Only 11 calendar months contain records/);
});

test("a stated gap in coverage is kept, and nothing changes when coverage is complete", () => {
  const kept = "Complete annual coverage is not established.";
  const value = applyCoverageCaveats({ headline: "h", points: ["p"], how_sure: kept, caveats: [] }, [
    incomplete,
  ]);
  expect(value.how_sure).toBe(kept);
  const full = { headline: "h", points: ["p"], how_sure: "Full year coverage.", caveats: [] };
  expect(applyCoverageCaveats({ ...full }, [{ ...incomplete, detail: "12 distinct months." }]).how_sure).toBe(
    "Full year coverage.",
  );
});

test("expected months come from the plan, or from a one-year source span when the plan has no years", () => {
  expect(expectedMonths({ from: 2025, to: 2025 }, { firstPeriod: null, lastPeriod: null }, today)).toBe(12);
  expect(expectedMonths({ from: 2024, to: 2025 }, { firstPeriod: 202401, lastPeriod: 202512 }, today)).toBe(
    undefined,
  );
  expect(expectedMonths(null, { firstPeriod: 202501, lastPeriod: 202512 }, today)).toBe(12);
  expect(expectedMonths(undefined, { firstPeriod: 202401, lastPeriod: 202512 }, today)).toBe(undefined);
  expect(expectedMonths(null, { firstPeriod: 202601, lastPeriod: 202609 }, today)).toBe(undefined);
});
