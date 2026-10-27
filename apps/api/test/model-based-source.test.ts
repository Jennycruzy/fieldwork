import { expect, test } from "vitest";
import { writerSchema } from "../src/agents/writer.js";

// Q03 shape: a per-resident rate that uses only CDC population columns, no health estimate.
const populationOnly = [
  {
    fields: ["tractfips", "totalpopulation"],
    fieldDefinitions: { totalpopulation: "Total population of Census 2020" },
  },
];
const answer = (how_sure: string, caveats: string[] = []) => ({
  headline: "Census Tract 12 had the most code violations per 1,000 residents in 2025.",
  points: ["Census Tract 12 had 818 violations."],
  how_sure,
  caveats,
});

test("a negated model-based label on population is accepted", () => {
  const r = writerSchema(populationOnly).safeParse(
    answer(
      "Violations are city records; population is Census 2020 population, not a model-based health estimate.",
    ),
  );
  expect(r.success).toBe(true);
});

test("describing the CDC release itself as model-based is accepted", () => {
  const r = writerSchema(populationOnly).safeParse(
    answer("City records are counts.", [
      "The CDC PLACES release is described as model-based census tract estimates, but only its Census 2020 population is used.",
    ]),
  );
  expect(r.success).toBe(true);
});

test("calling population or violations model-based is still rejected", () => {
  expect(
    writerSchema(populationOnly).safeParse(answer("Population is a model-based estimate.")).success,
  ).toBe(false);
  expect(
    writerSchema(populationOnly).safeParse(answer("The violation counts are model-based estimates.")).success,
  ).toBe(false);
});
