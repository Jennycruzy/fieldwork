import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { checkDraft } from "../src/checks.js";
import { PlanSchema } from "../src/types.js";

// Real result rows from the 25 Oct batch on d4e73b4; sentences rebuilt from the fragments the check flagged.
const run = (id: string) =>
  JSON.parse(readFileSync(`evidence/runs/${id}.run.json`, "utf8")).answer as {
    headers: string[];
    rows: (string | null)[][];
  };
const ok = (id: string, text: string, facts: string[] = []) => {
  const a = run(id);
  return checkDraft([text], a.headers, a.rows, facts);
};

test("Q07: a number before its month is checked against that month", () => {
  expect(
    ok(
      "r_20261025_adbdb2",
      "The city recorded 760 in January, 668 in February, 1,794 in March and 2,521 in June.",
    ).ok,
  ).toBe(true);
  expect(
    ok("r_20261025_adbdb2", "The city recorded 760 in January and 9,999 in June.").missingNumbers,
  ).toEqual(["9999"]);
  expect(ok("r_20261025_adbdb2", "The most recent month is October, with 694 violations.").ok).toBe(true);
});

test("Q12: calendar values stored as 59349.0 match 59,349, and a wrong lowest month is still caught", () => {
  expect(
    ok("r_20261025_97fe46", "Calls peaked at 59,349 in July and were lowest at 44,752 in February.").ok,
  ).toBe(true);
  expect(ok("r_20261025_97fe46", "November's 46,670 calls were the lowest of the year.").ok).toBe(false);
});

test("Q19: a second tract's value in the same sentence is not charged to the first", () => {
  expect(
    ok(
      "r_20261025_3cbb4c",
      "Census Tract 24 has the highest adult diabetes prevalence at 31.5%, followed by Census Tract 6 at 28.5%.",
    ).ok,
  ).toBe(true);
  expect(
    ok("r_20261025_3cbb4c", "Census Tract 24 has the highest adult diabetes prevalence at 35.5%.").ok,
  ).toBe(false);
  expect(
    ok(
      "r_20261025_3cbb4c",
      "These five tracts are ranked 1st through 5th in descending order of adult diabetes prevalence.",
    ).ok,
  ).toBe(true);
});

test("Q16: the name column is found by its header even when the rate comes first", () => {
  const a = run("r_20261025_1e1552");
  const row = a.rows.find((r) => r[1] === "Census Tract 56.07")!;
  const rate = Number(row[0]).toFixed(2),
    pop = Number(row[3]).toLocaleString("en-US");
  expect(
    checkDraft(
      [`Census Tract 56.07 has ${row[2]} pharmacy for ${pop} residents, ${rate} per 10,000 residents.`],
      a.headers,
      a.rows,
    ).ok,
  ).toBe(true);
  expect(checkDraft([`Census Tract 56.07 has 7 pharmacies.`], a.headers, a.rows).ok).toBe(false);
});

test("Q14: the question's own threshold may be quoted, and 'below-85' is not minus 85", () => {
  const facts = ["Quotable numbers: 85, 71 (from the question; 71 census tracts compared)"];
  expect(
    ok(
      "r_20261025_a9110a",
      "Census Tract 28 has 2 establishments with a latest score below 85, out of 31 inspected.",
      facts,
    ).ok,
  ).toBe(true);
  expect(
    ok(
      "r_20261025_a9110a",
      "Census Tract 28 has 2 below-85 establishments across all 71 tracts compared.",
      facts,
    ).ok,
  ).toBe(true);
  expect(
    ok("r_20261025_a9110a", "Census Tract 28 has 2 establishments with a latest score below 85.")
      .missingNumbers,
  ).toEqual(["85"]);
});

test("Q03: coverage stated for every tract is not a claimed pattern; a pattern in every tract still is", () => {
  expect(ok("r_20261025_db959e", "Population counts were available for every tract.").ok).toBe(true);
  expect(ok("r_20261025_db959e", "Violations were higher in every tract with more residents.").ok).toBe(
    false,
  );
});

test("Q17 (24 Oct rows): a wrong count for a named tract still fails", () => {
  expect(
    checkDraft(
      ["Census Tract 22.01 has 4 listed shelters."],
      run("r_20261024_362ff8").headers,
      run("r_20261024_362ff8").rows,
    ).ok,
  ).toBe(false);
});

test("Q24: a correct refusal with an empty analysis is a valid plan", () => {
  const reply = {
    in_scope: false,
    scope_limit: "non_public",
    out_of_scope_reason: "Private bank balances are not public records.",
    geography: null,
    years: null,
    measures: [],
    analysis: { basis: "none", denominator: "none", relationship: false, reason: "Out of scope" },
    output: null,
  };
  const r = PlanSchema.safeParse(reply);
  expect(r.success).toBe(true);
  expect(PlanSchema.safeParse({ ...reply, in_scope: true, scope_limit: null }).success).toBe(false);
});

import { rateArithmeticChecks } from "../src/analysis.js";
test("Q03/Q04 (25 Oct): correct rates pass whatever the count column is called, and a wrong rate still fails", () => {
  for (const id of ["r_20261025_db959e", "r_20261025_d68050"])
    expect(rateArithmeticChecks(run(id)).every((c) => c.ok)).toBe(true);
  const a = run("r_20261025_db959e");
  const rows = a.rows.map((r, i) => (i === 3 ? [r[0]!, String(Number(r[1]) + 1), ...r.slice(2)] : r));
  expect(rateArithmeticChecks({ headers: a.headers, rows }).every((c) => c.ok)).toBe(false);
  const b = run("r_20261025_d68050");
  const nulls = b.rows.map((r) => (r[2] === null ? [r[0]!, "5.0", ...r.slice(2)] : r));
  expect(rateArithmeticChecks({ headers: b.headers, rows: nulls }).every((c) => c.ok)).toBe(false);
});
