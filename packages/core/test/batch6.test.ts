import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { checkDraft } from "../src/checks.js";

// Sentences copied from the drafts the 25 Oct batch on c00148b saved with each run.
type Saved = {
  headers: string[];
  rows: (string | null)[][];
  checks: { detail: string }[];
  sources: { filter: string }[];
};
const run = (id: string) => JSON.parse(readFileSync(`evidence/runs/${id}.run.json`, "utf8")).answer as Saved;
const check = (id: string, sentence: string) => {
  const a = run(id);
  return checkDraft([sentence], a.headers, a.rows, [
    ...a.checks.map((c) => c.detail),
    ...a.sources.map((s) => s.filter),
  ]);
};
const passes = (id: string, s: string) => expect(check(id, s).ok, s).toBe(true);
const fails = (id: string, s: string) => expect(check(id, s).ok, s).toBe(false);

test("group sizes that match the rows are accepted (Q17, Q14)", () => {
  passes(
    "r_20261025_0b9c2c",
    "Six Montgomery census tracts each have one listed emergency shelter; 65 tracts have zero listed shelters.",
  );
  passes("r_20261025_0b9c2c", "65 of 71 Montgomery census tracts have 0 listed emergency shelters.");
  passes(
    "r_20261025_30eb78",
    "The next rank (3rd) includes 14 tracts tied with 1 below-threshold establishment each, including Census Tract 1, 10, 13, 16, 20, 27, 29.01, 29.02, 33.04, 5, 54.10, 56.04, 56.06, and 56.13.",
  );
  fails("r_20261025_0b9c2c", "64 of 71 Montgomery census tracts have 0 listed emergency shelters.");
});

test("'top 10', ranks and source names with spaced hyphens are not value claims (Q09)", () => {
  passes(
    "r_20261025_cd6f5a",
    "The top 10 request types also included Parking On Front Lawn (1,038), Traffic Issues for Montgomery Police Dept (681), FAQ-Municipal Court (612), Leaves and Debris Pick up (538), Clean Inlets (536), and FAQ-Montgomery Police Department (525).",
  );
  fails("r_20261025_cd6f5a", "FAQ-Montgomery Police Department had 600 requests.");
});

test("dates are not data values, a wrong total still fails (Q07)", () => {
  passes(
    "r_20261025_a99154",
    'Counts are through October 25, 2026, and are described as "so far" since the year is still in progress.',
  );
  passes("r_20261025_a99154", "Retrieval date is 2026-10-25; event dates span 2025-10-01 to 2026-10-16.");
  fails("r_20261025_a99154", "The total of 10 months recorded so far in 2026 sums to 16,388 violations.");
  passes("r_20261025_a99154", "The total of 10 months recorded so far in 2026 sums to 16,409 violations.");
});

test("a correct difference passes and wrong percent changes fail (Q12, Q08)", () => {
  passes(
    "r_20261025_0deef0",
    "The year started at 47,828 calls in January and ended at 46,670 in November, a drop of 1,158 calls from January to November.",
  );
  fails("r_20261025_0deef0", "July's call volume was 32.4% higher than February's low point.");
  passes("r_20261025_0deef0", "July's call volume was 32.6% higher than February's low point.");
  fails("r_20261025_0deef0", "November's call volume was 2.3% lower than January's starting point.");
  fails("r_20261025_72a6e2", "Census Tract 1 led with 1,419 requests, 25% more than Tract 25's 1,071.");
});

test("an invented population still fails (Q16)", () => {
  fails("r_20261025_527232", "Tracts range in population from 797 to 5,886 residents");
});

import { computedFigures } from "../../../apps/api/src/agents/writer.js";
test("computed figures give the Writer the real total and changes (Q07, Q12)", () => {
  const q07 = run("r_20261025_a99154"),
    q12 = run("r_20261025_0deef0");
  expect(computedFigures(q07.headers, q07.rows)).toMatchObject({
    total: 16409,
    highest: { row: "June 2026", value: 2521 },
    lowest: { row: "February 2026", value: 668 },
  });
  expect(computedFigures(q12.headers, q12.rows)).toMatchObject({
    highest_vs_lowest_percent: 32.6,
    last_minus_first: -1158,
    last_vs_first_percent: -2.4,
  });
});
