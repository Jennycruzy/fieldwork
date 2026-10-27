import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { finalizeDraft } from "../src/checks.js";

// Batch 15 answers whose Writer headline failed the number check and fell back to a row count.
// Each now leads with a checked sentence about the top row.
const runs: Record<string, string> = {
  r_20261027_ed8e07: "Nuisance comes first, with 7,170 records.",
  r_20261027_3b6106:
    "July 2025 recorded the highest monthly total at 59,349 calls, 32.6% above the February low",
  r_20261027_23973a: "Census Tract 56.11 issued 376 permits, the highest count among all 71 tracts",
  r_20261027_b5e99a: "Census Tract 24 comes first, with diabetes prevalence of 31.5.",
};

for (const [id, expected] of Object.entries(runs))
  test(`a failed headline is replaced by a checked sentence, not a row count (${id})`, () => {
    const a = JSON.parse(readFileSync(`evidence/runs/${id}.run.json`, "utf8")).answer;
    const out = finalizeDraft(
      { ...a.answer, headline: "Census Tract 999 had 123456789 of everything." },
      a.headers,
      a.rows,
      [],
    );
    expect(out.draft.headline).toBe(expected);
    if (out.draft.points.length > 1) expect(out.draft.points).not.toContain(expected);
  });
