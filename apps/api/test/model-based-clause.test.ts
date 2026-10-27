import { expect, test } from "vitest";
import { writerSchema } from "../src/agents/writer.js";

const populationOnly = [
  {
    fields: ["tractfips", "totalpopulation"],
    fieldDefinitions: { totalpopulation: "Total population of Census 2020" },
  },
];

test("a clause that names CDC estimates as separate from registry counts is accepted (Q16, batch 15)", () => {
  const r = writerSchema(populationOnly).safeParse({
    headline: "Forty-eight tracts have no listed pharmacy.",
    points: ["Census Tract 12 has no listed pharmacy."],
    how_sure: "The model-based estimates from CDC survey data are separate from the pharmacy locator counts.",
    caveats: [],
  });
  expect(r.success).toBe(true);
});

test("model-based modifiers on registry counts are still rejected", () => {
  const r = writerSchema(populationOnly).safeParse({
    headline: "Forty-eight tracts have no listed pharmacy.",
    points: [],
    how_sure: "CDC supplies model-based pharmacy counts.",
    caveats: [],
  });
  expect(r.success).toBe(false);
});
